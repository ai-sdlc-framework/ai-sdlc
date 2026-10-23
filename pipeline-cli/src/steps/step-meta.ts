/**
 * Step metadata shape (RFC-0056 phase 1). Each execute-pipeline step exports one
 * `{ id, inputs, outputs }` object; `id` is the registry key a Workflow document
 * uses as `impl`. `inputs` / `outputs` name a JSON schema in `spec/schemas`
 * (e.g. `backlog-task.v1`) or a `local:<name>` object schema.
 *
 * @module steps/step-meta
 */
export interface StepMeta {
  readonly id: string;
  readonly inputs: string;
  readonly outputs: string;
  /** Top-level fields a Workflow `when` may name after this step (RFC-0056 phase 2). */
  readonly outputFields?: readonly string[];
}
