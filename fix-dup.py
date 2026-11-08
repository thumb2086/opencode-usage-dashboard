c = open('tui-dashboard.js', encoding='utf-8').read()

# Find the two renderChart declarations
first = c.find('    const renderChart = (data, label, color, maxVal) => {')
second = c.find('    const renderChart = (data, label, color, maxVal) => {', first + 1)

# Show context around first
print("First renderChart at line:", c[:first].count('\n') + 1)
print("Second renderChart at line:", c[:second].count('\n') + 1)

# The first renderChart ends at the semicolon + blank line before "const maxInOut"
# Find the line after the first closing of renderChart function
# The pattern: "      return lines.join('\\n');\n    };" appears twice
marker = "      return lines.join('\\n');\n    };"
first_marker = c.find(marker, first)
second_marker = c.find(marker, first_marker + 1)

print("First marker at line:", c[:first_marker].count('\n') + 1)

# Remove everything from first renderChart to second renderChart (inclusive of first)
# We want to keep from first renderChart line to the line before second renderChart
old_block = c[first:first_marker + len(marker)]
print("Block to remove length:", len(old_block))
print("Block preview:", old_block[:200])

# Check what's between
between_preview = c[first_marker + len(marker):second][:200]
print("Between:", repr(between_preview))