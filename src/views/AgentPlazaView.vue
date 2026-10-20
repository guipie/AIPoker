<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { sfx } from "../audio/sfx";
import AgentModelEditor from "../components/AgentModelEditor.vue";
import { testLlmConnection, type LlmConfig } from "../engine/llm";
import {
  addCustomAgent,
  allAgents,
  beginGame,
  store,
  toggleDefault,
  type AgentDef,
} from "../store";

const agents = computed(() => allAgents());
const selected = computed(() => new Set(store.selectedAgentIds));

const MAX = 8; // 德州最多 8 个对手（共 9 人）

// 开始按钮可用性
const ddzOk = computed(
  () => store.selectedAgentIds.length >= 2 && store.selectedAgentIds.length <= 3
);
const holdemOk = computed(
  () => store.selectedAgentIds.length >= 5 && store.selectedAgentIds.length <= 8
);

function ddHint() {
  const n = store.selectedAgentIds.length;
  if (n < 2) return `斗地主需 3-4 人（含你），请再选 ${2 - n} 个对手`;
  if (n > 3) return `斗地主最多 4 人（含你），请减少到 3 个对手`;
  return "";
}
function holdemHint() {
  const n = store.selectedAgentIds.length;
  if (n < 5) return `德州需 6-9 人（含你），请再选 ${5 - n} 个对手`;
  if (n > 8) return `德州最多 9 人（含你），请减少到 8 个对手`;
  return "";
}

function toggleSelect(id: string) {
  sfx.click();
  const set = new Set(store.selectedAgentIds);
  if (set.has(id)) set.delete(id);
  else {
    if (set.size >= MAX) return;
    set.add(id);
  }
  store.selectedAgentIds = [...set];
}

function toggleStar(id: string) {
  sfx.click();
  toggleDefault(id);
}

function startDdz() {
  if (!ddzOk.value) return;
  sfx.click();
  beginGame("doudizhu", store.selectedAgentIds);
}
function startHoldem() {
  if (!holdemOk.value) return;
  sfx.click();
  beginGame("holdem", store.selectedAgentIds);
}

// ===== 新增自定义 agent 弹窗 =====
const COLORS = [
  ["from-cyan-500", "to-blue-700"],
  ["from-fuchsia-500", "to-pink-700"],
  ["from-lime-500", "to-emerald-700"],
  ["from-amber-500", "to-orange-700"],
  ["from-indigo-500", "to-purple-700"],
  ["from-rose-500", "to-red-700"],
];

const showModal = ref(false);
const form = reactive({
  name: "",
  emoji: "🤖",
  avatar: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  aggression: 0.5,
  tightness: 0.5,
});
const formError = ref("");

function openModal() {
  sfx.click();
  form.name = "";
  form.emoji = "🤖";
  form.avatar = "";
  form.baseUrl = store.settings.baseUrl || "https://api.deepseek.com/v1";
  form.apiKey = store.settings.apiKey || "";
  form.model = store.settings.model || "deepseek-flash";
  form.aggression = 0.5;
  form.tightness = 0.5;
  formError.value = "";
  showModal.value = true;
}

const saving = ref(false);

// ===== 修改某个 agent 的模型配置（内置 agent 也支持，持久化覆盖） =====
// 弹窗抽成共享组件 AgentModelEditor，牌桌上的状态徽章也复用同一个弹窗
const showEdit = ref(false);
const editId = ref<string | null>(null);

function openEdit(a: AgentDef) {
  sfx.click();
  editId.value = a.id;
  showEdit.value = true;
}

async function saveCustom() {
  if (!form.name.trim()) {
    formError.value = "请填写名称";
    return;
  }
  // 该 agent 实际会使用的大模型配置（未填则回落到全局设置）
  const cfg: LlmConfig = {
    enabled: store.settings.enabled,
    baseUrl: form.baseUrl.trim() || store.settings.baseUrl,
    model: form.model.trim() || store.settings.model,
    apiKey: form.apiKey.trim() || store.settings.apiKey,
    persona: "",
    temperature: store.settings.temperature,
  };
  // 仅在启用大模型时才校验连通性；未启用时直接保存（不影响规则 AI 玩牌）
  if (store.settings.enabled) {
    saving.value = true;
    formError.value = "正在检测大模型连接…";
    const r = await testLlmConnection(cfg);
    saving.value = false;
    if (!r.ok) {
      formError.value = "大模型连接失败：" + r.error;
      return;
    }
    formError.value = "";
  }

  const id = "custom-" + Date.now().toString(36);
  const [c1, c2] = COLORS[Math.floor(Math.random() * COLORS.length)];
  const a: AgentDef = {
    id,
    name: form.name.trim(),
    emoji: form.emoji.trim() || "🤖",
    avatar: form.avatar.trim() || undefined,
    color: c1,
    color2: c2,
    tagline: "自定义大模型",
    aggression: form.aggression,
    tightness: form.tightness,
    model: form.model.trim() || store.settings.model,
    baseUrl: form.baseUrl.trim() || undefined,
    apiKey: form.apiKey.trim() || undefined,
    persona: `由自定义大模型 ${form.model || store.settings.model} 驱动`,
    blurb: "你自定义的大模型牌手，性格由你设定。",
    isCustom: true,
  };
  addCustomAgent(a);
  sfx.click();
  showModal.value = false;
}
</script>

<template>
  <div
    class="h-full overflow-y-auto px-6 py-8"
    style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)"
  >
    <div class="mx-auto max-w-5xl">
      <div class="mb-4 flex items-center justify-between">
        <div class="text-3xl font-black text-amber-100">🤖 Agent 广场</div>
        <button class="btn btn-gold px-4 py-2 text-sm" @click="openModal">
          ＋ 新增自定义大模型
        </button>
      </div>
      <p class="mb-4 text-sm text-amber-100/60">
        点选卡片多选对手；点 ★ 设为「默认」（开局优先显示，没有默认则随机）。选好后右上角直接开局。
        点卡片上的「✏️ 模型」可修改该 agent 使用的接口 / Key / 模型名（开局前会逐一检测连通性）。
        <span class="text-amber-300">已选 {{ store.selectedAgentIds.length }}/{{ MAX }}</span>
      </p>

      <!-- 右上角开始按钮 -->
      <div
        class="sticky top-0 z-20 mb-4 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 py-3 backdrop-blur"
      >
        <span class="mr-auto text-xs text-white/55">多选对手后开局：</span>
        <div class="group relative">
          <button
            class="btn px-5 py-2.5 text-sm"
            :class="ddzOk ? 'btn-rose' : 'btn-slate opacity-50'"
            :disabled="!ddzOk"
            @click="startDdz"
          >
            🃏 开始斗地主
          </button>
          <span
            v-if="!ddzOk"
            class="pointer-events-none absolute right-0 top-full mt-1 hidden w-56 rounded-lg bg-black/90 px-3 py-2 text-[11px] text-amber-100 shadow-lg group-hover:block"
          >
            {{ ddHint() }}
          </span>
        </div>
        <div class="group relative">
          <button
            class="btn px-5 py-2.5 text-sm"
            :class="holdemOk ? 'btn-rose' : 'btn-slate opacity-50'"
            :disabled="!holdemOk"
            @click="startHoldem"
          >
            ♠ 开始德州
          </button>
          <span
            v-if="!holdemOk"
            class="pointer-events-none absolute right-0 top-full mt-1 hidden w-56 rounded-lg bg-black/90 px-3 py-2 text-[11px] text-amber-100 shadow-lg group-hover:block"
          >
            {{ holdemHint() }}
          </span>
        </div>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="a in agents"
          :key="a.id"
          class="hover-lift relative cursor-pointer overflow-hidden rounded-3xl border bg-gradient-to-br from-white/5 to-white/[0.02] p-5 shadow-xl transition-all"
          :class="
            selected.has(a.id) ? 'border-amber-400/70 ring-2 ring-amber-400/40' : 'border-white/10'
          "
          @click="toggleSelect(a.id)"
        >
          <!-- 选中勾 -->
          <div
            v-if="selected.has(a.id)"
            class="absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-xs font-black text-amber-950 shadow"
          >
            ✓
          </div>
          <!-- 默认星 -->
          <button
            class="absolute right-3 top-3 z-20 text-xl leading-none transition-transform"
            :class="selected.has(a.id) ? 'hidden' : ''"
            :title="store.defaultAgentIds.includes(a.id) ? '取消默认' : '设为默认'"
            @click.stop="toggleStar(a.id)"
          >
            <span
              :class="store.defaultAgentIds.includes(a.id) ? 'text-amber-300' : 'text-white/25'"
            >
              ★
            </span>
          </button>

          <div class="absolute -right-6 -top-6 text-[90px] opacity-10">{{ a.emoji }}</div>
          <div class="flex items-center gap-3">
            <span
              class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br text-2xl shadow-lg"
              :class="[a.color, a.color2]"
            >
              <img
                v-if="a.avatar"
                :src="a.avatar"
                class="h-10 w-10 rounded-xl object-cover"
                alt=""
              />
              <span v-else>{{ a.emoji }}</span>
            </span>
            <div>
              <div class="text-lg font-black text-white">{{ a.name }}</div>
              <div class="text-xs" :class="selected.has(a.id) ? 'text-amber-300' : 'text-white/55'">
                {{ a.tagline }}
                <span
                  v-if="a.isCustom"
                  class="ml-1 rounded bg-fuchsia-600/70 px-1 text-[9px] text-white"
                >
                  自定义
                </span>
              </div>
            </div>
          </div>

          <p class="mt-3 text-sm text-white/70">{{ a.blurb }}</p>

          <div class="mt-3 space-y-1.5">
            <div>
              <div class="flex justify-between text-[10px] text-white/55">
                <span>激进度</span>
                <span>{{ Math.round(a.aggression * 100) }}%</span>
              </div>
              <div class="h-1.5 rounded-full bg-white/10">
                <div
                  class="h-full rounded-full bg-rose-500"
                  :style="{ width: a.aggression * 100 + '%' }"
                ></div>
              </div>
            </div>
            <div>
              <div class="flex justify-between text-[10px] text-white/55">
                <span>紧度</span>
                <span>{{ Math.round(a.tightness * 100) }}%</span>
              </div>
              <div class="h-1.5 rounded-full bg-white/10">
                <div
                  class="h-full rounded-full bg-sky-500"
                  :style="{ width: a.tightness * 100 + '%' }"
                ></div>
              </div>
            </div>
          </div>

          <div class="mt-3 flex items-center justify-between gap-2">
            <button
              class="min-w-0 truncate rounded-full bg-black/40 px-2 py-1 text-[10px] text-emerald-200/80 transition-colors hover:bg-black/60 hover:text-amber-200"
            >
              模型：{{ a.model ?? "全局设置" }}
            </button>
            <button
              class="min-w-0 truncate rounded-full px-2 py-1 text-[10px] transition-colors hover:bg-black/60 hover:text-amber-200"
              :title="
                a.isCustom
                  ? '修改该模型的接口/Key/模型名'
                  : '修改该 agent 使用的大模型（接口/Key/模型名）'
              "
              @click.stop="openEdit(a)"
            >
              ✏️
              <span v-if="a.baseUrl" class="text-amber-200/70">· 自定义接口</span>
              <span
                v-if="store.agentOverrides[a.id]"
                class="ml-1 rounded bg-sky-600/80 px-1 text-[9px] text-white"
              >
                已改
              </span>
            </button>
            <!-- <span
              class="shrink-0 text-xs"
              :class="selected.has(a.id) ? 'text-amber-300' : 'text-white/40'"
            >
              {{
                selected.has(a.id)
                  ? "已选 ✓"
                  : store.defaultAgentIds.includes(a.id)
                    ? "默认 ★"
                    : "点击选择"
              }}
            </span> -->
          </div>
        </div>
      </div>
    </div>

    <!-- 自定义大模型弹窗 -->
    <transition name="ball">
      <div
        v-if="showModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
        @click.self="showModal = false"
      >
        <div
          class="w-[460px] max-w-full rounded-3xl border border-white/15 bg-gradient-to-b from-slate-800 to-slate-900 p-6 shadow-2xl"
        >
          <div class="mb-4 text-xl font-black text-amber-100">＋ 新增自定义大模型对手</div>

          <div class="space-y-3">
            <div class="flex gap-3">
              <div class="w-20 shrink-0">
                <label class="mb-1 block text-xs font-semibold text-white/70">头像</label>
                <div
                  class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-700 text-2xl shadow"
                >
                  <img
                    v-if="form.avatar"
                    :src="form.avatar"
                    class="h-12 w-12 rounded-xl object-cover"
                    alt=""
                  />
                  <span v-else>{{ form.emoji }}</span>
                </div>
                <input
                  v-model="form.emoji"
                  maxlength="2"
                  class="mt-1 w-full rounded border border-white/15 bg-black/40 px-1 py-0.5 text-center text-sm text-white"
                  placeholder="🤖"
                />
              </div>
              <div class="flex-1">
                <label class="mb-1 block text-xs font-semibold text-white/70">名称</label>
                <input
                  v-model="form.name"
                  class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                  placeholder="例如：GPT战神"
                />
                <label class="mb-1 mt-2 block text-xs font-semibold text-white/70">
                  头像图片 URL（可选）
                </label>
                <input
                  v-model="form.avatar"
                  class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                  placeholder="https://..."
                />
              </div>
            </div>

            <div>
              <label class="mb-1 block text-xs font-semibold text-white/70">
                接口地址 Base URL
              </label>
              <input
                v-model="form.baseUrl"
                class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                placeholder="https://api.deepseek.com/v1"
              />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-xs font-semibold text-white/70">模型名称</label>
                <input
                  v-model="form.model"
                  class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                  placeholder="deepseek-flash"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-semibold text-white/70">API Key</label>
                <input
                  v-model="form.apiKey"
                  type="password"
                  class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400"
                  placeholder="sk-..."
                />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label
                  class="mb-1 flex items-center justify-between text-xs font-semibold text-white/70"
                >
                  <span>激进度</span>
                  <span class="text-rose-300">{{ Math.round(form.aggression * 100) }}%</span>
                </label>
                <input
                  v-model.number="form.aggression"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  class="w-full accent-rose-400"
                />
              </div>
              <div>
                <label
                  class="mb-1 flex items-center justify-between text-xs font-semibold text-white/70"
                >
                  <span>紧度</span>
                  <span class="text-sky-300">{{ Math.round(form.tightness * 100) }}%</span>
                </label>
                <input
                  v-model.number="form.tightness"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  class="w-full accent-sky-400"
                />
              </div>
            </div>

            <div v-if="formError" class="rounded-lg bg-rose-500/20 px-3 py-2 text-xs text-rose-200">
              {{ formError }}
            </div>
          </div>

          <div class="mt-5 flex justify-end gap-3">
            <button
              class="btn-ghost rounded-xl px-5 py-2 text-sm"
              :disabled="saving"
              @click="showModal = false"
            >
              取消
            </button>
            <button
              class="btn btn-primary px-6 py-2 text-sm"
              :disabled="saving"
              @click="saveCustom"
            >
              {{ saving ? "检测中…" : "保存并添加" }}
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 修改模型配置弹窗（共享组件 AgentModelEditor，牌桌页面也复用同一个弹窗） -->
    <AgentModelEditor :open="showEdit" :agent-id="editId" @close="showEdit = false" />
  </div>
</template>
