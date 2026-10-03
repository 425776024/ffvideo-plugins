export function videoQueryMatches(query, title) {
  // Search indexing also matches uploader/category prose; require visible subject words in the file title.
  if (/donat|fundrais|wikipedia|wikimedia/i.test(title) && !/donat|fundrais|wikipedia|wikimedia/i.test(query)) return false;
  const aliases = { coffee: /coffee|espresso|cappuccino|latte/i, cup: /cup|mug|cappuccino|latte/i, mug: /cup|mug|cappuccino|latte/i, forest: /forest|woods|woodland|jungle/i, trail: /trail|path|walk|hike/i, path: /trail|path|walk|hike/i,
    walking: /walk|hike|trail/i, stream: /stream|creek|brook|river|waterfall/i, river: /river|stream|creek|brook|waterfall/i,
    flowing: /flow|current|waterfall|stream/i, raindrops: /rain|drop(?:let)?s?/i, rain: /rain|drop(?:let)?s?/i,
    canopy: /canopy|tree|foliage|leaves/i, trees: /tree|canopy|foliage|leaves/i };
  const terms = query.toLowerCase().match(/[a-z]+/g)?.filter(word => !['the', 'a', 'of', 'in', 'real', 'video', 'footage', 'close', 'up', 'macro', 'wide', 'fruit', 'human'].includes(word)).slice(0, 2) || [];
  return terms.length > 0 && terms.every(word => aliases[word] ? aliases[word].test(title) : new RegExp(`\\b${word}(?:s|es)?\\b`, 'i').test(title.replace(/_/g, ' ')));
}
export function imageQueryMatches(query, title) {
  const terms = query.toLowerCase().match(/[a-z]+/g)?.filter(word => !['the','a','of','in','real','image','photo','close','up','macro','wide','human','fruit'].includes(word)).slice(0,2) || [];
  return terms.some(term => videoQueryMatches(term, title));
}
