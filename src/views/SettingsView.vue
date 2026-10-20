<script setup lang="ts">
import { ref, watch } from "vue";
import { setSoundEnabled, sfx } from "../audio/sfx";
import { testLlmConnection, type LlmConfig } from "../engine/llm";
import { saveSettings, store } from "../store";

const draft = ref({ ...store.settings, sound: store.settings.sound ?? true });

watch(
  () => store.settings,
  v => {
    draft.value = { ...v };
  },
  { deep: true }
);

const presets = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { label: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
];

function applyPreset(p: (typeof presets)[number]) {
  draft.value.baseUrl = p.baseUrl;
  draft.value.model = p.model;
  sfx.click();
}

// ===== 连接检测 =====
const testing = ref(false);
const testMsg = ref<{ ok: boolean; text: string } | null>(null);

/** 校验当前草稿里的 Key/接口是否可用；返回是否通过 */
async function testConnection(): Promise<boolean> {
  testing.value = true;
  testMsg.value = { ok: true, text: "正在检测大模型连接…" };
  const cfg: LlmConfig = {
    enabled: draft.value.enabled,
    baseUrl: draft.value.baseUrl,
    model: draft.value.model,
    apiKey: draft.value.apiKey,
    persona: draft.value.persona,
    temperature: draft.value.temperature,
  };
  const r = await testLlmConnection(cfg);
  testing.value = false;
  testMsg.value = r.ok
    ? { ok: true, text: "✅ 连接成功，API Key 有效" }
    : { ok: false, text: "❌ " + r.error };
  return r.ok;
}

async function save() {
  sfx.click();
  // 启用大模型时，保存前必须先验证 Key 是否正确；关闭时直接保存（作为连接失败时的退路）
  if (draft.value.enabled) {
    const ok = await testConnection();
    if (!ok) return; // Key 不正确 → 拒绝保存
  }
  store.settings = { ...draft.value };
  saveSettings();
  setSoundEnabled(draft.value.sound);
  testMsg.value = { ok: true, text: "✅ 设置已保存" };
}
</script>

<template>
  <div
    class="h-full overflow-y-auto px-6 py-8"
    style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)"
  >
    <div class="mx-auto max-w-2xl">
      <div class="mb-6 text-3xl font-black text-amber-100">⚙️ 设置</div>

      <div class="space-y-5 rounded-3xl border border-white/10 bg-black/30 p-6">
        <!-- 大模型开关 -->
        <label
          class="flex cursor-pointer items-center justify-between rounded-xl bg-white/5 px-4 py-3"
        >
          <span>
            <span class="block text-sm font-semibold text-white">启用大模型大脑</span>
            <span class="block text-xs text-white/55">关闭时 AI 对手使用内置规则引擎</span>
          </span>
          <input v-model="draft.enabled" type="checkbox" class="peer sr-only" />
          <span
            class="relative h-6 w-11 rounded-full bg-slate-600 transition-colors peer-checked:bg-emerald-500 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5"
          ></span>
        </label>

        <!-- 音效开关 -->
        <label
          class="flex cursor-pointer items-center justify-between rounded-xl bg-white/5 px-4 py-3"
        >
          <span>
            <span class="block text-sm font-semibold text-white">音效</span>
            <span class="block text-xs text-white/55">发牌、下注、胜利等程序化音效</span>
          </span>
          <input v-model="draft.sound" type="checkbox" class="peer sr-only" />
          <span
            class="relative h-6 w-11 rounded-full bg-slate-600 transition-colors peer-checked:bg-emerald-500 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5"
          ></span>
        </label>

        <div class="border-t border-white/10 pt-4">
          <div class="mb-2 text-xs font-semibold text-white/70">快速预设（大模型）</div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="p in presets"
              :key="p.label"
              class="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-xs text-white hover:bg-white/15"
              @click="applyPreset(p)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-xs font-semibold text-white/70">
              接口地址 (Base URL)
            </label>
            <input
              v-model="draft.baseUrl"
              class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              placeholder="https://api.deepseek.com/v1"
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs font-semibold text-white/70">模型名称</label>
              <input
                v-model="draft.model"
                class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
                placeholder="deepseek-flash"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-white/70">API Key</label>
              <input
                v-model="draft.apiKey"
                type="password"
                class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
                placeholder="sk-..."
              />
            </div>
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold text-white/70">
              全局人设 / 性格（可选）
            </label>
            <textarea
              v-model="draft.persona"
              rows="2"
              class="w-full resize-none rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              placeholder="例如：激进、喜欢诈唬"
            ></textarea>
          </div>
          <div>
            <label
              class="mb-1 flex items-center justify-between text-xs font-semibold text-white/70"
            >
              <span>随机性 (temperature)</span>
              <span class="text-amber-300">{{ draft.temperature.toFixed(1) }}</span>
            </label>
            <input
              v-model.number="draft.temperature"
              type="range"
              min="0"
              max="1.5"
              step="0.1"
              class="w-full accent-emerald-400"
            />
          </div>
        </div>

        <div
          v-if="testMsg"
          class="rounded-lg px-3 py-2 text-xs"
          :class="
            testMsg.ok ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'
          "
        >
          {{ testMsg.text }}
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <button class="btn btn-slate px-5 py-2.5" :disabled="testing" @click="testConnection">
            {{ testing ? "检测中…" : "🔌 测试连接" }}
          </button>
          <button class="btn btn-primary px-6 py-2.5" :disabled="testing" @click="save">
            {{ testing ? "检测中…" : "保存设置" }}
          </button>
        </div>
      </div>

      <p class="mt-4 text-center text-[11px] text-amber-100/30">
        提示：启用大模型或填写了 API Key 后，保存前会自动校验 Key 是否正确，校验失败将无法保存。
        <br />
        每个 Agent 可在「Agent 广场」单独指定模型与人设，覆盖这里的全局设置。
      </p>
    </div>
  </div>
</template>
