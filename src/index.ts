export type ObservedType =
  'null' | 'boolean' | 'integer' | 'number' | 'string' | 'object' | 'array';
export type InferredType = ObservedType | 'unknown';
export interface InferenceOptions {
  sampleSize?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxProperties?: number;
  maxStringLength?: number;
}
export interface StringSummary {
  minLength: number;
  maxLength: number;
  empty: number;
}
export interface NumberSummary {
  min: number;
  max: number;
}
export interface ArraySummary {
  minLength: number;
  maxLength: number;
}
export interface InferredNode {
  path: string;
  present: number;
  missing: number;
  required: boolean;
  nullable: boolean;
  types: ObservedType[];
  counts: Record<ObservedType, number>;
  preferred: InferredType;
  confidence: number;
  string?: StringSummary;
  number?: NumberSummary;
  array?: ArraySummary;
  properties?: Record<string, InferredNode>;
  items?: InferredNode;
}
export interface InferenceReport {
  sampledRows: number;
  sampleLimit: number;
  saturated: boolean;
  schema: InferredNode;
}
export interface Inference {
  add(row: Readonly<Record<string, unknown>>): void;
  snapshot(): InferenceReport;
}
export interface Correction {
  path: string;
  type: InferredType;
  nullable?: boolean;
  required?: boolean;
}
export interface CorrectedField {
  path: string;
  inferred: InferredType;
  type: InferredType;
  nullable: boolean;
  required: boolean;
  corrected: boolean;
  confidence: number;
}
const kinds: ObservedType[] = ['null', 'boolean', 'integer', 'number', 'string', 'object', 'array'];
interface Node {
  counts: Record<ObservedType, number>;
  string?: StringSummary;
  number?: NumberSummary;
  array?: ArraySummary;
  properties: Map<string, Node>;
  items?: Node;
}
interface Config {
  sampleSize: number;
  maxDepth: number;
  maxNodes: number;
  maxProperties: number;
  maxStringLength: number;
}
function integer(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer >= ${minimum}.`);
  return value;
}
function configuration(options: InferenceOptions): Config {
  if ((options.maxDepth ?? 16) > 256) throw new RangeError('maxDepth cannot exceed 256.');
  return {
    sampleSize: integer(options.sampleSize ?? 1000, 'sampleSize', 1),
    maxDepth: integer(options.maxDepth ?? 16, 'maxDepth', 0),
    maxNodes: integer(options.maxNodes ?? 100_000, 'maxNodes', 1),
    maxProperties: integer(options.maxProperties ?? 10_000, 'maxProperties', 0),
    maxStringLength: integer(options.maxStringLength ?? 10_000, 'maxStringLength', 0),
  };
}
function node(): Node {
  return {
    counts: { null: 0, boolean: 0, integer: 0, number: 0, string: 0, object: 0, array: 0 },
    properties: new Map(),
  };
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function observed(value: unknown): ObservedType {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value))
    return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  if (plain(value)) return 'object';
  throw new TypeError(
    'Only finite JSON values, dense arrays and plain data objects are supported.',
  );
}
interface Value {
  type: ObservedType;
  value: unknown;
  children: [string, Value][];
}
function validate(
  value: unknown,
  depth: number,
  config: Config,
  seen: Set<object>,
  used: { nodes: number; properties: number },
): Value {
  if (depth > config.maxDepth) throw new RangeError('Input exceeds maxDepth.');
  if (++used.nodes > config.maxNodes) throw new RangeError('Input exceeds maxNodes.');
  const type = observed(value);
  const result: Value = { type, value, children: [] };
  if (typeof value === 'string' && value.length > config.maxStringLength) {
    throw new RangeError('String exceeds maxStringLength UTF-16 units.');
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cyclic values are not supported.');
    seen.add(value);
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol'))
      throw new TypeError('Symbol keys are not JSON.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > config.maxNodes - used.nodes)
        throw new RangeError('Array exceeds maxNodes.');
      if (Object.keys(descriptors).length !== value.length + 1)
        throw new TypeError('Arrays must be dense without extra properties.');
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new TypeError('Array elements must be enumerable data properties.');
        result.children.push([
          String(index),
          validate(descriptor.value, depth + 1, config, seen, used),
        ]);
      }
    } else {
      const entries = Object.entries(descriptors);
      used.properties += entries.length;
      if (used.properties > config.maxProperties)
        throw new RangeError('Input exceeds maxProperties.');
      for (const [key, descriptor] of entries) {
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw new TypeError('Object fields must be enumerable data properties.');
        result.children.push([key, validate(descriptor.value, depth + 1, config, seen, used)]);
      }
    }
    seen.delete(value);
  }
  return result;
}
function merge(target: Node, input: Value): void {
  target.counts[input.type]++;
  if (input.type === 'string') {
    const value = input.value as string;
    const summary = target.string ?? { minLength: value.length, maxLength: value.length, empty: 0 };
    summary.minLength = Math.min(summary.minLength, value.length);
    summary.maxLength = Math.max(summary.maxLength, value.length);
    if (value.length === 0) summary.empty++;
    target.string = summary;
  } else if (input.type === 'integer' || input.type === 'number') {
    const value = input.value as number;
    target.number = {
      min: Math.min(target.number?.min ?? value, value),
      max: Math.max(target.number?.max ?? value, value),
    };
  } else if (input.type === 'object') {
    for (const [key, value] of input.children) {
      let child = target.properties.get(key);
      if (!child) {
        child = node();
        target.properties.set(key, child);
      }
      merge(child, value);
    }
  } else if (input.type === 'array') {
    const length = input.children.length;
    target.array = {
      minLength: Math.min(target.array?.minLength ?? length, length),
      maxLength: Math.max(target.array?.maxLength ?? length, length),
    };
    target.items ??= node();
    for (const [, value] of input.children) merge(target.items, value);
  }
}
function segment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
function materialize(value: Node, path: string, opportunities: number): InferredNode {
  const counts = { ...value.counts };
  const present = kinds.reduce((sum, type) => sum + counts[type], 0);
  const types = kinds.filter(
    (type) => counts[type] > 0 && !(type === 'integer' && counts.number > 0),
  );
  const nonNull = present - counts.null;
  let preferred: InferredType = 'unknown';
  let best = 0;
  for (const type of types) {
    if (type === 'null') continue;
    const frequency = counts[type] + (type === 'number' ? counts.integer : 0);
    if (frequency > best) {
      preferred = type;
      best = frequency;
    }
  }
  const result: InferredNode = {
    path,
    present,
    missing: opportunities - present,
    required: present === opportunities && opportunities > 0,
    nullable: counts.null > 0,
    types,
    counts,
    preferred,
    confidence: nonNull === 0 ? 0 : best / nonNull,
  };
  if (value.string) result.string = { ...value.string };
  if (value.number) result.number = { ...value.number };
  if (value.array) result.array = { ...value.array };
  if (counts.object) {
    result.properties = Object.fromEntries(
      [...value.properties]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [
          key,
          materialize(child, `${path}/properties/${segment(key)}`, counts.object),
        ]),
    );
  }
  if (value.items) {
    const total = kinds.reduce((sum, type) => sum + value.items!.counts[type], 0);
    result.items = materialize(value.items, `${path}/items`, total);
  }
  return result;
}
export function createInference(options: InferenceOptions = {}): Inference {
  const config = configuration(options);
  const root = node();
  let sampled = 0;
  let nodes = 0;
  let properties = 0;
  return {
    add(row) {
      if (sampled === config.sampleSize) throw new RangeError('Sample is full.');
      if (!plain(row)) throw new TypeError('Each dataset row must be a plain object.');
      const used = { nodes, properties };
      // Validate the entire row before mutating any accumulated statistics.
      const validated = validate(row, 0, config, new Set(), used);
      merge(root, validated);
      nodes = used.nodes;
      properties = used.properties;
      sampled++;
    },
    snapshot() {
      return {
        sampledRows: sampled,
        sampleLimit: config.sampleSize,
        saturated: sampled === config.sampleSize,
        schema: materialize(root, '', sampled),
      };
    },
  };
}
export function infer(
  rows: Iterable<Readonly<Record<string, unknown>>>,
  options: InferenceOptions = {},
): InferenceReport {
  if (rows == null || typeof rows[Symbol.iterator] !== 'function')
    throw new TypeError('Rows must be iterable.');
  const config = configuration(options);
  const inference = createInference(config);
  let sampled = 0;
  for (const row of rows) {
    inference.add(row);
    if (++sampled === config.sampleSize) break;
  }
  return inference.snapshot();
}
export function fields(
  report: InferenceReport,
  corrections: readonly Correction[] = [],
): CorrectedField[] {
  const nodes = new Map<string, InferredNode>();
  const visit = (value: InferredNode) => {
    nodes.set(value.path, value);
    for (const child of Object.values(value.properties ?? {})) visit(child);
    if (value.items) visit(value.items);
  };
  visit(report.schema);
  const overrides = new Map<string, Correction>();
  for (const correction of corrections) {
    if (!nodes.has(correction.path))
      throw new TypeError(`Unknown correction path: ${correction.path}`);
    if (overrides.has(correction.path))
      throw new TypeError(`Duplicate correction path: ${correction.path}`);
    if (correction.type !== 'unknown' && !kinds.includes(correction.type))
      throw new TypeError('Unknown correction type.');
    for (const value of [correction.nullable, correction.required]) {
      if (value !== undefined && typeof value !== 'boolean')
        throw new TypeError('Correction flags must be booleans.');
    }
    overrides.set(correction.path, correction);
  }
  return [...nodes.values()].map((value) => {
    const correction = overrides.get(value.path);
    return {
      path: value.path,
      inferred: value.preferred,
      type: correction?.type ?? value.preferred,
      nullable: correction?.nullable ?? value.nullable,
      required: correction?.required ?? value.required,
      corrected: correction !== undefined,
      confidence: value.confidence,
    };
  });
}
