import json, os

# Read the current pricing.js
with open('pricing.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Read the OpenRouter models cache
cache_path = os.path.join(os.environ['USERPROFILE'], '.cache', 'opencode', 'models.json')
with open(cache_path, 'r', encoding='utf-8') as f:
    cache = json.load(f)

# Build a list of available paid models (with prices)
paid_models = []
for provider, val in cache.items():
    if isinstance(val, dict) and 'models' in val:
        for model, info in val['models'].items():
            cost = info.get('cost', {})
            if cost and (cost.get('input', 0) or cost.get('output', 0) or cost.get('cache_read', 0)):
                paid_models.append((provider, model, cost))

# Free model mapping - map free models to their paid counterparts
# Using the cheapest available paid model with similar base name
free_mapping = {
    'opencode/space-bunny-free': 'openrouter/mistralai/mistral-7b-instruct',
    'opencode/beam-free': 'openrouter/microsoft/phi-3-mini-128k-instruct',
    'opencode/fledge-alpha-free': 'openrouter/mistralai/mistral-7b-instruct',
    'opencode/grok-code': 'openrouter/xai/grok-4.1-fast-reasoning',
    'opencode/laguna-s-2.1-free': 'nano-gpt/poolside/laguna-s-2.1',
    'opencode/x-preview-f-free': 'openrouter/openrouter/free',
    'opencode/nemotron-3.5-lightning-free': 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b',
    'opencode/big-pickle': 'openrouter/openrouter/free',
    'opencode/ling-3.0-flash-fin-free': 'openrouter/qwen/qwen3-8-flash',
    'opencode/mimo-v2.5-free': 'openrouter/xiaomi/mimo-v2.5',
    'opencode/nemotron-3-super-free': 'openrouter/nvidia/nemotron-3-super-120b-a12b',
    'opencode/nemotron-3-ultra-free': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b',
    'opencode/glm-4.7-free': 'openrouter/z-ai/glm-4.7',
    'opencode/glm-5-free': 'openrouter/z-ai/glm-5',
    'opencode/mimo-v2-flash-free': 'openrouter/xiaomi/mimo-v2-flash',
    'opencode/qwen3.6-plus-free': 'openrouter/qwen/qwen3.6-235b-a22b',
    'opencode/mimo-v2-omni-free': 'openrouter/xiaomi/mimo-v2-omni',
    'opencode/mimo-v2-pro-free': 'openrouter/xiaomi/mimo-v2-pro',
    'opencode/ling-3.0-tiny-free': 'openrouter/qwen/qwen3-8-flash',
    'opencode/trinity-large-preview-free': 'openrouter/openrouter/free',
    'opencode/nemotron-3.5-super-vl-free': 'openrouter/nvidia/nemotron-3.5-super-vl',
    'opencode/ling-2.6-flash-free': 'openrouter/qwen/qwen3-8-flash',
    'opencode/minimax-m2.5-free': 'openrouter/minimax/minimax-m2.5',
    'opencode/minimax-m3-free': 'openrouter/minimax/minimax-m3',
    'opencode/muse-spark-1.2-contributor-free': 'openrouter/muse-spark/muse-spark-1.2',
    'opencode/muse-spark-1.3-contributor-free': 'openrouter/muse-spark/muse-spark-1.3',
    'opencode/deepseek-v4-flash-free': 'openrouter/deepseek/deepseek-v4-flash',
    'opencode/deepseek-v4.1-flash-free': 'openrouter/deepseek/deepseek-v4.1-flash',
    'opencode/hy3-free': 'openrouter/tencent/hy3',
    'opencode/glm-5.3-flash-free': 'openrouter/z-ai/glm-5.3-flash',
    'opencode/space-bunny-free': 'openrouter/mistralai/mistral-7b-instruct',
    'opencode/beam-free': 'openrouter/microsoft/phi-3-mini-128k-instruct',
    'opencode/fledge-alpha-free': 'openrouter/mistralai/mistral-7b-instruct',
    'opencode/nemotron-3-super-free': 'openrouter/nvidia/nemotron-3-super-120b-a12b',
    'opencode/nemotron-3-ultra-free': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b',
    'opencode/nemotron-3.5-super-vl-free': 'openrouter/nvidia/nemotron-3.5-super-vl',
    'opencode/big-pickle': 'openrouter/openrouter/free',
    'opencode/grok-code': 'openrouter/xai/grok-4.1-fast-reasoning',
    'opencode/x-preview-f-free': 'openrouter/openrouter/free',
    'opencode/ling-3.0-flash-fin-free': 'openrouter/qwen/qwen3-8-flash',
    'opencode/ling-3.0-tiny-free': 'openrouter/qwen/qwen3-8-flash',
    'opencode/ling-2.6-flash-free': 'openrouter/qwen/qwen3-8-flash',
    'opencode/trinity-large-preview-free': 'openrouter/openrouter/free',
    'opencode/mimo-v2.5-free': 'openrouter/xiaomi/mimo-v2.5',
    'opencode/mimo-v2-flash-free': 'openrouter/xiaomi/mimo-v2-flash',
    'opencode/mimo-v2-omni-free': 'openrouter/xiaomi/mimo-v2-omni',
    'opencode/mimo-v2-pro-free': 'openrouter/xiaomi/mimo-v2-pro',
    'opencode/qwen3.6-plus-free': 'openrouter/qwen/qwen3.6-235b-a22b',
    'opencode/glm-4.7-free': 'openrouter/z-ai/glm-4.7',
    'opencode/glm-5-free': 'openrouter/z-ai/glm-5',
    'opencode/hy3-free': 'openrouter/tencent/hy3',
    'opencode/glm-5.3-flash-free': 'openrouter/z-ai/glm-5.3-flash',
    'opencode/minimax-m2.5-free': 'openrouter/minimax/minimax-m2.5',
    'opencode/minimax-m3-free': 'openrouter/minimax/minimax-m3',
    'opencode/muse-spark-1.2-contributor-free': 'openrouter/muse-spark/muse-spark-1.2',
    'opencode/muse-spark-1.3-contributor-free': 'openrouter/muse-spark/muse-spark-1.3',
    'opencode/deepseek-v4-flash-free': 'openrouter/deepseek/deepseek-v4-flash',
    'opencode/deepseek-v4.1-flash-free': 'openrouter/deepseek/deepseek-v4.1-flash',
    'opencode/nemotron-3.5-super-vl-free': 'openrouter/nvidia/nemotron-3.5-super-vl',
}

# Build the FREE_MODEL_MAPPING JS object
lines = []
for key, val in free_mapping.items():
    lines.append(f"  '{key}': '{val}',")
mapping_str = '\n'.join(lines)

# Find the FREE_MODEL_MAPPING in content and replace
import re
# Remove everything from "const FREE_MODEL_MAPPING" to the next function or export
start = content.find('const FREE_MODEL_MAPPING = {')
end = content.find('function getFreeModelMapping', start)
if end == -1:
    end = content.find('module.exports', start)
    if end == -1:
        end = len(content)

# Replace the section
new_section = "const FREE_MODEL_MAPPING = {\n" + mapping_str + "\n};\n\n"
content = content[:start] + new_section + content[end:]

with open('pricing.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated pricing.js with comprehensive FREE_MODEL_MAPPING")