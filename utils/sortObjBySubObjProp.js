const sortObjBySubObjProp = (obj, key) => {
  const sortedKeys = Object.keys(obj).sort(function (a, b) {
    return (obj[b][key] - obj[a][key]);
  })
  let tmpObj = {}
  for (const k of sortedKeys) {
    tmpObj[k] = obj[k]
  }
  return tmpObj
}

module.exports = sortObjBySubObjProp