const sortObjBySubObjProp = (obj, key, reverse = false) => {
  const sortedKeys = Object.keys(obj).sort(function (a, b) {
    return reverse ? obj[a][key] - obj[b][key] : obj[b][key] - obj[a][key]
  })
  let tmpObj = {}
  for (const k of sortedKeys) {
    tmpObj[k] = obj[k]
  }
  return tmpObj
}

module.exports = sortObjBySubObjProp
