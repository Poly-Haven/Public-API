import { Filter } from 'bad-words'

let filter: Filter | undefined

const isBadWord = (word: string): boolean => {
  if (!filter) {
    filter = new Filter()
    filter.removeWords('cox', 'wang')
    // bad-words 4 dropped this one word from the 3.x list it otherwise matches exactly; restored so
    // the names we hide did not change with the upgrade.
    filter.addWords('qweir')
  }
  return filter.isProfane(word)
}

export default isBadWord
