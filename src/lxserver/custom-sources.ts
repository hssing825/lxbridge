export function extractCustomSources(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.list)) return payload.list;
  if (payload && typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}
