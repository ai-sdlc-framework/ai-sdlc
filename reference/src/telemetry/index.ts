export {
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  AI_SDLC_PREFIX,
} from './semantic-conventions.js';

export { getTracer, getMeter, withSpan, withSpanSync } from './instrumentation.js';
