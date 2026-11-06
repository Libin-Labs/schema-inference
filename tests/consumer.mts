import {
  createInference,
  infer,
  fields,
  type InferenceReport,
  type CorrectedField,
  type InferredType,
} from '@lp-labs/schema-inference';
const builder = createInference({ sampleSize: 5 });
builder.add({ name: 'a' });
const report: InferenceReport = infer([{ id: 1 }, { id: null }]);
const plan: CorrectedField[] = fields(report, [
  { path: '/properties/id', type: 'string', nullable: true },
]);
const type: InferredType | undefined = plan[0]?.type;
// @ts-expect-error top-level input must be an object record.
builder.add(1);
// @ts-expect-error date inference is deliberately unsupported.
fields(report, [{ path: '', type: 'date' }]);
void [type, builder.snapshot()];
