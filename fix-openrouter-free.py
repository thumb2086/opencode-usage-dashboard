c = open('pricing.js', encoding='utf-8').read()
# Replace all occurrences of openrouter/openrouter/free with openrouter/xai/grok-4.1-fast-reasoning
c = c.replace("'openrouter/openrouter/free'", "'openrouter/xai/grok-4.1-fast-reasoning'")
with open('pricing.js', 'w', encoding='utf-8') as f:
    f.write(c)
print("Done")