const pricing = require('./pricing');
const cat = pricing.loadCatalog();
if (cat.data && cat.data.openrouter) {
  const models = cat.data.openrouter.models;
  let priced = 0, unpriced = 0;
  for (const [model, info] of Object.entries(models)) {
    const c = info.cost;
    if (c && (c.input || c.output || c.cache_read)) priced++;
    else unpriced++;
  }
  console.log('OpenRouter models:', priced + unpriced);
  console.log('Priced:', priced);
  console.log('Unpriced:', unpriced);
}

let total = 0, totalPriced = 0, totalUnpriced = 0;
const cat2 = pricing.loadCatalog();
if (cat2.data) {
  for (const [provider, val] of Object.entries(cat2.data)) {
    if (val.models) {
      for (const [model, info] of Object.entries(val.models)) {
        total++;
        const c = info.cost;
        if (c && (c.input || c.output || c.cache_read)) totalPriced++;
        else totalUnpriced++;
      }
    }
  }
  console.log('\nTotal models:', total);
  console.log('Priced:', totalPriced);
  console.log('Unpriced:', totalUnpriced);
  console.log('Coverage:', ((totalPriced/total)*100).toFixed(1) + '%');
}