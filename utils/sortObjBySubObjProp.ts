// Returns a copy of `obj` with its keys reordered by the numeric `key` of each value, largest first
// (smallest first with `reverse`).
const sortObjBySubObjProp = <K extends string, V extends Record<K, number>>(
  obj: Record<string, V>,
  key: K,
  reverse = false
): Record<string, V> => {
  const sortedKeys = Object.keys(obj).sort(function (a, b) {
    return reverse ? obj[a][key] - obj[b][key] : obj[b][key] - obj[a][key]
  })
  const tmpObj: Record<string, V> = {}
  for (const k of sortedKeys) {
    tmpObj[k] = obj[k]
  }
  return tmpObj
}

export default sortObjBySubObjProp
