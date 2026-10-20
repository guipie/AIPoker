<script setup lang="ts">
import { computed } from "vue";
import type { Card as CardType } from "../engine/cards";
import { isRed, rankLabel, SUIT_SYMBOL } from "../engine/cards";

const props = defineProps<{
  card: CardType;
  selected?: boolean;
  faceDown?: boolean;
  small?: boolean;
  size?: "sm" | "md" | "lg" | "xlg";
  disabled?: boolean;
  flippable?: boolean; // 是否在 faceDown 切换时播放翻牌动画
}>();

const emit = defineEmits<{ (e: "toggle"): void }>();

const sizeClass = computed(() => {
  if (props.small) return "w-11 h-[4.6rem] text-[11px]";
  if (props.size === "sm") return "w-12 h-[5.1rem] text-xs";
  if (props.size === "lg") return "w-[4.6rem] h-[6.6rem] text-base";
  if (props.size === "xlg") return "w-[5.2rem] h-[7.4rem] text-lg";
  return "w-16 h-[5.9rem] text-sm";
});

const red = computed(() => isRed(props.card));
const symbol = computed(() => SUIT_SYMBOL[props.card.suit]);
const label = computed(() => rankLabel(props.card));
const isJoker = computed(() => props.card.suit === "joker");
const isBig = computed(() => props.card.rank === 17);

// 数字牌（2~10）的居中点数排布提示：用点数决定画几颗（简化处理，展示花色符号）
const centerGlyph = computed(() => {
  if (isJoker.value) return "王"; // 窄牌上 "JOKER" 会折行，单个「王」更清晰（大小由角标区分）
  const r = props.card.rank;
  if (r >= 11 && r <= 14) return label.value; // J Q K A
  return symbol.value;
});
</script>

<template>
  <div
    class="relative transition-transform duration-150 ease-out"
    :class="[
      sizeClass,
      disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      !disabled && !faceDown ? 'hover:-translate-y-3' : '',
      selected ? '!-translate-y-5' : '',
    ]"
    :style="{ zIndex: selected ? 40 : undefined }"
    @click="!disabled && !faceDown && emit('toggle')"
  >
    <!-- 3D 翻牌容器 -->
    <div
      class="card-flip absolute inset-0"
      :style="
        faceDown
          ? 'transform: rotateY(180deg); transform-style: preserve-3d'
          : 'transform-style: preserve-3d'
      "
    >
      <!-- 牌面 -->
      <div
        class="card-face absolute inset-0 flex flex-col overflow-hidden rounded-lg border border-slate-300/90 bg-gradient-to-br from-white via-white to-slate-100"
        style="backface-visibility: hidden"
      >
        <div
          class="absolute left-1 top-0.5 flex flex-col items-center leading-none"
          :class="
            isJoker
              ? isBig
                ? 'text-red-600'
                : 'text-slate-800'
              : red
              ? 'text-red-600'
              : 'text-slate-900'
          "
        >
          <span class="font-extrabold">{{ isJoker ? (isBig ? "大" : "小") : label }}</span>
          <span v-if="!isJoker">{{ symbol }}</span>
        </div>

        <div class="flex flex-1 items-center justify-center">
          <span
            v-if="isJoker"
            class="font-black tracking-tighter"
            :class="[
              isBig ? 'text-red-600' : 'text-slate-800',
              small ? 'text-[10px]' : 'text-base',
            ]"
            style="-webkit-text-stroke: 0.4px currentColor"
          >
            {{ centerGlyph }}
          </span>
          <span
            v-else
            class="drop-shadow-sm"
            :class="[red ? 'text-red-600' : 'text-slate-900', small ? 'text-xl' : 'text-[2rem]']"
          >
            {{ centerGlyph }}
          </span>
        </div>

        <div
          class="absolute bottom-0.5 right-1 flex rotate-180 flex-col items-center leading-none"
          :class="
            isJoker
              ? isBig
                ? 'text-red-600'
                : 'text-slate-800'
              : red
              ? 'text-red-600'
              : 'text-slate-900'
          "
        >
          <span class="font-extrabold">{{ isJoker ? (isBig ? "大" : "小") : label }}</span>
          <span v-if="!isJoker">{{ symbol }}</span>
        </div>

        <div
          v-if="selected"
          class="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-amber-400"
          style="box-shadow: 0 0 14px rgba(251, 191, 36, 0.75) inset"
        ></div>
      </div>

      <!-- 牌背 -->
      <div
        class="card-face absolute inset-0 overflow-hidden rounded-lg border border-indigo-950/70 bg-gradient-to-br from-indigo-600 via-indigo-800 to-indigo-950"
        style="backface-visibility: hidden; transform: rotateY(180deg)"
      >
        <div
          class="felt-weave absolute inset-1 rounded-[5px] border border-indigo-300/25 bg-[radial-gradient(circle_at_50%_50%,rgba(129,140,248,0.35),transparent_65%)]"
        >
          <div class="flex h-full w-full items-center justify-center">
            <span class="text-lg text-indigo-200/70 drop-shadow">♠</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
