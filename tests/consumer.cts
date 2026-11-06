import { infer, fields, type InferredType } from '@lp-labs/schema-inference';
const report = infer([{ flag: true }]);
const type: InferredType = report.schema.preferred;
const value: number | undefined = fields(report)[0]?.confidence;
void [type, value];
