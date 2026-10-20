<!-- 修改某个 agent 的模型配置（baseUrl / Key / 模型名）——广场与牌桌共用 -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  agentById,
  clearAgentOverride,
  saveAgentOverride,
  store,
  updateCustomAgent,
} from "../store";
import { testLlmConnection, type LlmConfig } from "../engine/llm";
import { sfx } from "../audio/sfx";

const props = defineProps<{ open: boolean; agentId: string | null }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved", id: string): void }>();

const target = computed(() => (props.agentId ? agentById(props.agentId) ?? null : null));
const isCustom = computed(() => !!target.value?.isCustom);
const hasOverride = computed(() => !!target.value && !!store.agentOverrides[target.value.id]);

const form = reactive({ baseUrl: "", apiKey: "", model: "" });
const testing = ref(false);
const msg = ref("");
const msgOk = ref(true);

// 打开时按当前生效配置预填（没有覆盖则留空 = 回落全局）
watch(
  () => [props.open, props.agentId],
  () => {
    if (props.open && target.value) {
      form.baseUrl = target.value.baseUrl ?? "";
      form.apiKey = target.value.apiKey ?? "";
      form.model = target.value.model ?? store.settings.model;
      msg.value = "";
      msgOk.value = true;
      testing.value = false;
    }
  },
  { immediate: true },
);

async function save() {
  const t = target.value;
  if (!t) return;
  // 仅在启用大模型时才做连通性校验；未启用时直接保存（不与“规则 AI 也能玩”冲突）
  if (store.settings.enabled) {
    testing.value = true;
    msgOk.value = true;
    msg.value = "正在检测大模型连接…";
    const cfg: LlmConfig = {
      enabled: store.settings.enabled,
      baseUrl: form.baseUrl.trim() || store.settings.baseUrl,
      model: form.model.trim() || store.settings.model,
      apiKey: form.apiKey.trim() || store.settings.apiKey,
      persona: t.persona ?? "",
      temperature: store.settings.temperature,
    };
    const r = await testLlmConnection(cfg);
    testing.value = false;
    if (!r.ok) {
      msgOk.value = false;
      msg.value = "大模型连接失败：" + r.error;
      return;
    }
  }
  msg.value = "";
  if (t.isCustom) updateCustomAgent(t.id, { ...form });
  else saveAgentOverride(t.id, { ...form });
  sfx.click();
  emit("saved", t.id);
  emit("close");
}

function reset() {
  const t = target.value;
  if (!t || t.isCustom) return;
  sfx.click();
  clearAgentOverride(t.id);
  emit("saved", t.id);
  emit("close");
}
</script>

<template>
  <transition name="ball">
    <div
      v-if="open && target"
      class="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div
        class="w-[460px] max-w-full rounded-3xl border border-white/15 bg-gradient-to-b from-slate-800 to-slate-900 p-6 shadow-2xl"
      >
        <div class="mb-1 text-xl font-black text-amber-100">⚙️ 修改模型配置</div>
        <div class="mb-4 text-xs text-white/55">
          {{ target.name }}（{{ isCustom ? "自定义模型" : "内置 agent" }}）·
          留空的项将回落到「设置」里的全局配置
        </div>

        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-xs font-semibold text-white/70">接口地址 Base URL</label>
            <input
              v-model="form.baseUrl"
              class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
              :placeholder="'留空使用全局地址（' + store.settings.baseUrl + '）'"
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs font-semibold text-white/70">模型名称</label>
              <input
                v-model="form.model"
                class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                placeholder="如 deepseek-chat"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-white/70">API Key</label>
              <input
                v-model="form.apiKey"
                type="password"
                class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                placeholder="留空使用全局 Key"
              />
            </div>
          </div>

          <div
            v-if="msg"
            class="rounded-lg px-3 py-2 text-xs"
            :class="msgOk ? (testing ? 'bg-sky-500/20 text-sky-200' : 'bg-emerald-500/20 text-emerald-200') : 'bg-rose-500/20 text-rose-200'"
          >
            {{ msg }}
          </div>
        </div>

        <div class="mt-5 flex items-center justify-between gap-3">
          <button
            v-if="!isCustom && hasOverride"
            class="btn-ghost rounded-xl px-4 py-2 text-xs"
            @click="reset"
          >
            ↺ 恢复默认配置
          </button>
          <span v-else></span>
          <div class="flex gap-3">
            <button class="btn-ghost rounded-xl px-5 py-2 text-sm" :disabled="testing" @click="emit('close')">
              取消
            </button>
            <button class="btn btn-primary px-6 py-2 text-sm" :disabled="testing" @click="save">
              {{ testing ? "检测中…" : "检测并保存" }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>
