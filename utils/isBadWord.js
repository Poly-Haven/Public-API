const isBadWord = (word) => {
  const badWords = require('bad-words')
  const bw = new badWords()
  bw.removeWords('cox', 'wang')
  return bw.isProfane(word)
}

module.exports = isBadWord
