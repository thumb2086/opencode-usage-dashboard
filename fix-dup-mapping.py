c = open('pricing.js', encoding='utf-8').read()
lines = c.split('\n')

# Find both FREE_MODEL_MAPPING declarations
first_decl = None
second_decl = None
for i, line in enumerate(lines):
    if 'const FREE_MODEL_MAPPING = {' in line:
        if first_decl is None:
            first_decl = i
        else:
            second_decl = i

print(f"First decl: {first_decl+1}, Second decl: {second_decl+1}")

# Find the end of the first FREE_MODEL_MAPPING (the closing }; before getFreeModelMapping)
get_free_func = None
for i in range(first_decl, second_decl):
    if 'function getFreeModelMapping' in lines[i]:
        get_free_func = i
        break

print(f"getFreeModelMapping at: {get_free_func+1}")

# Remove lines from first_decl to get_free_func (exclusive)
# But keep the stripFree line
# New content: lines[0:first_decl] + lines[get_free_func:]
new_lines = lines[:first_decl] + lines[get_free_func:]
new_content = '\n'.join(new_lines)

# Also need to update getFreeModelMapping to use the second FREE_MODEL_MAPPING
# The second one is keyed by full provider/model name
# The getFreeModelMapping checks FREE_MODEL_MAPPING[key] || FREE_MODEL_MAPPING[model]
# This should work since the second object is keyed by 'opencode/space-bunny-free' etc.

with open('pricing.js', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Done")