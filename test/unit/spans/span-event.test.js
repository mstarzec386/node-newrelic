'use strict'

const tap = require('tap')
const DatastoreShim = require('../../../lib/shim/datastore-shim')
const expect = require('chai').expect
const helper = require('../../lib/agent_helper')
const https = require('https')
const SpanEvent = require('../../../lib/spans/span-event')

tap.test('#constructor() should construct an empty span event', (t) => {
  const attrs = {}
  const span = new SpanEvent(attrs)

  t.ok(span)
  t.ok(span instanceof SpanEvent)
  t.equal(span.attributes, attrs)

  t.ok(span.intrinsics)
  t.equal(span.intrinsics.type, 'Span')
  t.equal(span.intrinsics.category, SpanEvent.CATEGORIES.GENERIC)

  const emptyProps = [
    'traceId',
    'guid',
    'parentId',
    'transactionId',
    'sampled',
    'priority',
    'name',
    'timestamp',
    'duration'
  ]
  emptyProps.forEach((prop) => expect(span.intrinsics).to.have.property(prop, null))

  t.end()
})

tap.test('fromSegment()', (t) => {
  t.autoend()

  let agent = null

  t.beforeEach((done) => {
    agent = helper.instrumentMockedAgent()
    done()
  })

  t.afterEach((done) => {
    helper.unloadAgent(agent)
    done()
  })

  t.test('should create a generic span with a random segment', (t) => {
    helper.runInTransaction(agent, (transaction) => {
      transaction.sampled = true
      transaction.priority = 42

      setTimeout(() => {
        const segment = agent.tracer.getTransaction().trace.root.children[0]
        segment.addCustomSpanAttribute('Span Lee', 'no prize')
        const span = SpanEvent.fromSegment(segment, 'parent')

        // Should have all the normal properties.
        t.ok(span)
        t.ok(span instanceof SpanEvent)

        t.ok(span.intrinsics)
        t.equal(span.intrinsics.type, 'Span')
        t.equal(span.intrinsics.category, SpanEvent.CATEGORIES.GENERIC)

        t.equal(span.intrinsics.traceId, transaction.traceId)
        t.equal(span.intrinsics.guid, segment.id)
        t.equal(span.intrinsics.parentId, 'parent')
        t.equal(span.intrinsics.transactionId, transaction.id)
        t.equal(span.intrinsics.sampled, true)
        t.equal(span.intrinsics.priority, 42)
        t.equal(span.intrinsics.name, 'timers.setTimeout')
        t.equal(span.intrinsics.timestamp, segment.timer.start)

        expect(span.intrinsics).to.have.property('duration').within(0.03, 0.3)

        // Generic should not have 'span.kind' or 'component'
        t.equal(span.intrinsics['span.kind'], null)
        t.equal(span.intrinsics.component, null)

        t.ok(span.customAttributes)
        const customAttributes = span.customAttributes

        t.ok(customAttributes['Span Lee'])

        t.ok(span.attributes)
        const attributes = span.attributes

        // Should have no http properties.
        const hasOwnAttribute = Object.hasOwnProperty.bind(attributes)
        t.notOk(hasOwnAttribute('externalLibrary'))
        t.notOk(hasOwnAttribute('externalUri'))
        t.notOk(hasOwnAttribute('externalProcedure'))

        // Should have no datastore properties.
        t.notOk(hasOwnAttribute('db.statement'))
        t.notOk(hasOwnAttribute('db.instance'))
        t.notOk(hasOwnAttribute('peer.hostname'))
        t.notOk(hasOwnAttribute('peer.address'))

        t.end()
      }, 50)
    })
  })

  t.test('should create an http span with a external segment', (t) => {
    helper.runInTransaction(agent, (transaction) => {
      transaction.sampled = true
      transaction.priority = 42

      https.get('https://example.com?foo=bar', (res) => {
        res.resume()
        res.on('end', () => {
          const segment = agent.tracer.getTransaction().trace.root.children[0]
          const span = SpanEvent.fromSegment(segment, 'parent')

          // Should have all the normal properties.
          t.ok(span)
          t.ok(span instanceof SpanEvent)
          t.ok(span instanceof SpanEvent.HttpSpanEvent)

          t.ok(span.intrinsics)
          t.equal(span.intrinsics.type, 'Span')
          t.equal(span.intrinsics.category, SpanEvent.CATEGORIES.HTTP)

          t.equal(span.intrinsics.traceId, transaction.traceId)
          t.equal(span.intrinsics.guid, segment.id)
          t.equal(span.intrinsics.parentId, 'parent')
          t.equal(span.intrinsics.transactionId, transaction.id)
          t.equal(span.intrinsics.sampled, true)
          t.equal(span.intrinsics.priority, 42)

          t.equal(span.intrinsics.name, 'External/example.com:443/')
          t.equal(span.intrinsics.timestamp, segment.timer.start)

          expect(span.intrinsics).to.have.property('duration').within(0.01, 2)

          // Should have type-specific intrinsics
          t.equal(span.intrinsics.component, 'http')
          t.equal(span.intrinsics['span.kind'], 'client')

          t.ok(span.attributes)
          const attributes = span.attributes

          // Should have (most) http properties.
          t.equal(attributes['http.url'], 'https://example.com:443/')
          t.ok(attributes['http.method'])
          t.equal(attributes['http.statusCode'], 200)
          t.equal(attributes['http.statusText'], 'OK')

          // Should have no datastore properties.
          const hasOwnAttribute = Object.hasOwnProperty.bind(attributes)
          t.notOk(hasOwnAttribute('db.statement'))
          t.notOk(hasOwnAttribute('db.instance'))
          t.notOk(hasOwnAttribute('peer.hostname'))
          t.notOk(hasOwnAttribute('peer.address'))

          t.end()
        })
      })
    })
  })

  t.test('should create an datastore span with an datastore segment', (t) => {
    agent.config.distributed_tracing.enabled = true
    agent.config.transaction_tracer.record_sql = 'raw'

    const shim = new DatastoreShim(agent, 'test-data-store', '', 'TestStore')

    const dsConn = {myDbOp: (query, cb) => setTimeout(cb, 50)}
    let longQuery = ''
    while (Buffer.byteLength(longQuery, 'utf8') < 2001) {
      longQuery += 'a'
    }
    shim.recordQuery(dsConn, 'myDbOp', {
      callback: shim.LAST,
      query: shim.FIRST,
      parameters: {
        host: 'my-db-host',
        port_path_or_id: '/path/to/db.sock',
        database_name: 'my-database',
        collection: 'my-collection'
      }
    })

    shim.setParser((query) => {
      return {
        collection: 'test',
        operation: 'test',
        query
      }
    })

    helper.runInTransaction(agent, (transaction) => {
      transaction.sampled = true
      transaction.priority = 42

      dsConn.myDbOp(longQuery, () => {
        transaction.end()
        const segment = transaction.trace.root.children[0]
        const span = SpanEvent.fromSegment(segment, 'parent')

        // Should have all the normal properties.
        t.ok(span)
        t.ok(span instanceof SpanEvent)
        t.ok(span instanceof SpanEvent.DatastoreSpanEvent)

        t.ok(span.intrinsics)
        t.equal(span.intrinsics.type, 'Span')
        t.equal(span.intrinsics.category, SpanEvent.CATEGORIES.DATASTORE)

        t.equal(span.intrinsics.traceId, transaction.traceId)
        t.equal(span.intrinsics.guid, segment.id)
        t.equal(span.intrinsics.parentId, 'parent')
        t.equal(span.intrinsics.transactionId, transaction.id)
        t.equal(span.intrinsics.sampled, true)
        t.equal(span.intrinsics.priority, 42)

        t.equal(span.intrinsics.name, 'Datastore/statement/TestStore/test/test')
        t.equal(span.intrinsics.timestamp, segment.timer.start)

        expect(span.intrinsics).to.have.property('duration').within(0.03, 0.7)

        // Should have (most) type-specific intrinsics
        t.equal(span.intrinsics.component, 'TestStore')
        t.equal(span.intrinsics['span.kind'], 'client')

        t.ok(span.attributes)
        const attributes = span.attributes

        // Should have not http properties.
        const hasOwnAttribute = Object.hasOwnProperty.bind(attributes)
        t.notOk(hasOwnAttribute('http.url'))
        t.notOk(hasOwnAttribute('http.method'))

        // Should have (most) datastore properties.
        t.ok(attributes['db.instance'])
        t.equal(attributes['db.collection'], 'my-collection')
        t.equal(attributes['peer.hostname'], 'my-db-host')
        t.equal(attributes['peer.address'], 'my-db-host:/path/to/db.sock')

        const statement = attributes['db.statement']
        t.ok(statement)

        // Testing query truncation
        t.ok(statement.endsWith('...'))
        t.equal(Buffer.byteLength(statement, 'utf8'), 2000)

        t.end()
      })
    })
  })

  t.test('should serialize intrinsics to proper format with toJSON method', (t) => {
    helper.runInTransaction(agent, (transaction) => {
      transaction.priority = 42
      transaction.sample = true

      setTimeout(() => {
        const segment = agent.tracer.getSegment()
        const span = SpanEvent.fromSegment(segment, 'parent')

        const payload = span.toJSON()
        const [serializedSpan] = payload

        t.equal(serializedSpan.type, 'Span')
        t.equal(serializedSpan.traceId, transaction.traceId)
        t.equal(serializedSpan.guid, segment.id)
        t.equal(serializedSpan.parentId, 'parent')
        t.equal(serializedSpan.transactionId, transaction.id)
        t.equal(serializedSpan.priority, 42)
        t.ok(serializedSpan.name)
        t.equal(serializedSpan.category, 'generic')
        t.ok(serializedSpan.timestamp)
        t.ok(serializedSpan.duration)

        t.end()
      }, 10)
    })
  })
})
