import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createInference, infer, fields } from '../dist/esm/index.js';

test('inference distinguishes missing fields, explicit nulls and required observations', () => {
  const report = infer([{ id: 1, name: 'a' }, { id: 2, name: null }, { id: 3 }]);
  const name = report.schema.properties.name;
  assert.equal(report.sampledRows, 3);
  assert.equal(name.present, 2);
  assert.equal(name.missing, 1);
  assert.equal(name.required, false);
  assert.equal(name.nullable, true);
  assert.deepEqual(name.types, ['null', 'string']);
  assert.equal(name.preferred, 'string');
  assert.equal(name.confidence, 1);
  assert.equal(report.schema.properties.id.required, true);
});
test('numeric promotion preserves integer counts, finite ranges and observed type unions', () => {
  const field = infer([{ n: 1 }, { n: 2.5 }, { n: -3 }, { n: '4' }]).schema.properties.n;
  assert.deepEqual(field.types, ['number', 'string']);
  assert.equal(field.counts.integer, 2);
  assert.equal(field.counts.number, 1);
  assert.equal(field.preferred, 'number');
  assert.equal(field.confidence, 0.75);
  assert.deepEqual(field.number, { min: -3, max: 2.5 });
});
test('string summaries count UTF-16 units without guessing dates, IDs or numeric strings', () => {
  const schema = infer([{ s: '' }, { s: '😀' }, { s: '2026-01-01' }, { s: '123' }]).schema
    .properties.s;
  assert.deepEqual(schema.string, { minLength: 0, maxLength: 10, empty: 1 });
  assert.deepEqual(schema.types, ['string']);
});
test('nested property opportunities count parent objects rather than absent or non-object parents', () => {
  const report = infer([{ person: { age: 20 } }, { person: {} }, {}, { person: null }]);
  const person = report.schema.properties.person;
  const age = person.properties.age;
  assert.equal(person.missing, 1);
  assert.equal(person.nullable, true);
  assert.equal(age.present, 1);
  assert.equal(age.missing, 1);
  assert.equal(age.path, '/properties/person/properties/age');
});
test('arrays aggregate all item observations including mixed types and nested object fields', () => {
  const list = infer([{ list: [{ a: 1 }, { b: true }] }, { list: [] }, { list: [null, 3] }]).schema
    .properties.list;
  assert.deepEqual(list.array, { minLength: 0, maxLength: 2 });
  assert.equal(list.items.present, 4);
  assert.equal(list.items.missing, 0);
  assert.deepEqual(list.items.types, ['null', 'integer', 'object']);
  assert.equal(list.items.properties.a.missing, 1);
  assert.equal(list.items.properties.b.path, '/properties/list/items/properties/b');
  assert.equal(infer([{ a: [] }]).schema.properties.a.items.preferred, 'unknown');
});
test('empty and null-only samples report unknown instead of guessing', () => {
  const empty = infer([]);
  assert.equal(empty.schema.preferred, 'unknown');
  assert.equal(empty.schema.confidence, 0);
  assert.equal(empty.schema.required, false);
  assert.deepEqual(empty.schema.types, []);
  const field = infer([{ a: null }]).schema.properties.a;
  assert.equal(field.preferred, 'unknown');
  assert.equal(field.nullable, true);
  assert.equal(field.confidence, 0);
  assert.deepEqual(field.types, ['null']);
});
test('sample limit stops without pulling another row and closes generator', () => {
  let pulled = 0,
    closed = false;
  function* rows() {
    try {
      for (let i = 0; i < 10; i++) {
        pulled++;
        yield { i };
      }
    } finally {
      closed = true;
    }
  }
  const report = infer(rows(), { sampleSize: 2 });
  assert.equal(pulled, 2);
  assert.equal(closed, true);
  assert.equal(report.saturated, true);
  assert.equal(report.sampledRows, 2);
});
test('incremental builder snapshots are independent and input mutations do not alter statistics', () => {
  const builder = createInference();
  const row = { n: 1, child: { a: 'x' } };
  builder.add(row);
  const before = builder.snapshot();
  row.n = 99;
  row.child.a = 'longer';
  builder.add({ n: 2 });
  before.schema.properties.n.number.max = 999;
  before.schema.properties.child.properties.a.counts.string = 999;
  const after = builder.snapshot();
  assert.equal(after.schema.properties.n.number.max, 2);
  assert.equal(after.schema.properties.child.properties.a.string.maxLength, 1);
  assert.equal(after.schema.properties.child.properties.a.counts.string, 1);
  assert.equal(after.sampledRows, 2);
});
test('failed rows are atomic and do not consume quotas or partial statistics', () => {
  const builder = createInference({ maxNodes: 6, maxProperties: 4 });
  builder.add({ id: 1 });
  const before = builder.snapshot();
  assert.throws(() => builder.add({ id: 2, bad: undefined }), TypeError);
  assert.deepEqual(builder.snapshot(), before);
  assert.throws(() => builder.add({ n: { deep: { value: 1 } }, extra: 2 }), RangeError);
  assert.deepEqual(builder.snapshot(), before);
  builder.add({ id: 2 });
  assert.equal(builder.snapshot().sampledRows, 2);
});
test('accessors and invalid JSON are rejected without invoking getters', () => {
  let accessed = false;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      accessed = true;
      return 1;
    },
  });
  const cycle = {};
  cycle.self = cycle;
  const sparse = new Array(2);
  sparse[0] = 1;
  const extra = [1];
  extra.x = 2;
  for (const bad of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    new Map(),
    cycle,
    sparse,
    extra,
    accessor,
    { [Symbol('s')]: 1 },
  ]) {
    assert.throws(() => infer([{ value: bad }]));
  }
  assert.equal(accessed, false);
  assert.throws(() => infer([Object.defineProperty({}, 'hidden', { value: 1 })]), /enumerable/);
  assert.throws(() => infer([[]]), /plain object/);
});
test('resource limits are enforced at exact boundaries', () => {
  assert.equal(infer([{ a: 1 }], { maxNodes: 2, maxProperties: 1, maxDepth: 1 }).sampledRows, 1);
  assert.throws(() => infer([{ a: 1 }], { maxNodes: 1 }), /maxNodes/);
  assert.throws(() => infer([{ a: 1 }], { maxProperties: 0 }), /maxProperties/);
  assert.throws(() => infer([{ a: 1 }], { maxDepth: 0 }), /maxDepth/);
  assert.throws(() => infer([{ a: 'ab' }], { maxStringLength: 1 }), /maxStringLength/);
  assert.throws(() => createInference({ maxDepth: 257 }), /maxDepth/);
  const builder = createInference({ sampleSize: 1 });
  builder.add({});
  assert.throws(() => builder.add({}), /full/);
  for (const value of [0, -1, 1.5, Infinity, NaN])
    assert.throws(() => createInference({ sampleSize: value }), RangeError);
});
test('prototype-like field names and JSON pointer escaping are safe and unambiguous', () => {
  const row = JSON.parse('{"__proto__":1,"constructor":true,"a/b~c":{"items":2},"*":[]}');
  const report = infer([row]);
  assert.equal(report.schema.properties.__proto__.preferred, 'integer');
  assert.equal(report.schema.properties.constructor.preferred, 'boolean');
  assert.equal(
    report.schema.properties['a/b~c'].properties.items.path,
    '/properties/a~1b~0c/properties/items',
  );
  assert.equal(Object.getPrototypeOf(report.schema.properties), Object.prototype);
  assert.equal({}.polluted, undefined);
});
test('corrections produce a separate field plan without rewriting observed evidence', () => {
  const report = infer([{ code: 123 }, { code: 456 }]);
  const before = structuredClone(report);
  const plan = fields(report, [
    { path: '/properties/code', type: 'string', required: false, nullable: true },
  ]);
  const code = plan.find((field) => field.path === '/properties/code');
  assert.deepEqual(code, {
    path: '/properties/code',
    inferred: 'integer',
    type: 'string',
    nullable: true,
    required: false,
    corrected: true,
    confidence: 1,
  });
  assert.deepEqual(report, before);
  assert.equal(plan[0].corrected, false);
});
test('unknown paths, duplicate corrections and invalid correction types fail explicitly', () => {
  const report = infer([{ a: 1 }]);
  assert.throws(() => fields(report, [{ path: '/missing', type: 'string' }]), /Unknown/);
  assert.throws(
    () =>
      fields(report, [
        { path: '', type: 'array' },
        { path: '', type: 'string' },
      ]),
    /Duplicate/,
  );
  assert.throws(() => fields(report, [{ path: '', type: 'date' }]), /type/);
  assert.throws(() => fields(report, [{ path: '', type: 'object', required: 'yes' }]), /booleans/);
});
test('majority ties are deterministic and confidence is a sample agreement ratio', () => {
  const value = infer([{ a: true }, { a: 1 }, { a: null }, {}]).schema.properties.a;
  assert.equal(value.preferred, 'boolean');
  assert.equal(value.confidence, 0.5);
  assert.equal(value.missing, 1);
});
test('shared noncyclic objects are valid and no caller-owned references are retained', () => {
  const shared = { a: 1 };
  const result = infer([{ left: shared, right: shared }]);
  shared.a = 2;
  assert.equal(result.schema.properties.left.properties.a.number.max, 1);
  assert.equal(result.schema.properties.right.properties.a.number.max, 1);
});
test('CommonJS supports incremental inference and explicit corrections', () => {
  const require = createRequire(import.meta.url);
  const api = require('../dist/cjs/index.js');
  const builder = api.createInference();
  builder.add({ id: 1 });
  assert.equal(
    api.fields(builder.snapshot()).find((v) => v.path === '/properties/id').type,
    'integer',
  );
});
