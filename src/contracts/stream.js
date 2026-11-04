import { NewTallyEvent } from './schemas.js';

export const EVENT_FIELD = 'event';

export function streamFields(event) {
  const { stream_id: _ignored, ...rest } = event;
  return [EVENT_FIELD, JSON.stringify(rest)];
}

export function eventFromEntry([id, fields]) {
  const i = fields.indexOf(EVENT_FIELD);
  if (i === -1) throw new Error(`Entry ${id} has no "${EVENT_FIELD}" field`);
  return NewTallyEvent.parse({ ...JSON.parse(fields[i + 1]), stream_id: id });
}
