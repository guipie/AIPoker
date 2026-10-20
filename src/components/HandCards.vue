<script setup lang="ts">
import { computed } from "vue";
import { ddzValue, type Card } from "../engine/cards";
import CardComp from "./Card.vue";

const props = defineProps<{
  cards: Card[];
  selectedIds: Set<string>;
  disabled?: boolean;
  flat?: boolean; // 横排（不扇形）
}>();

const emit = defineEmits<{
  (e: "toggle", id: string): void;
}>();

// 手牌排序：按斗地主牌力从大到小（大王 > 小王 > 2 > A > K …）
const sortedCards = computed(() => {
  return [...props.cards].sort((a, b) => {
    const va = ddzValue(a);
    const vb = ddzValue(b);
    if (vb !== va) return vb - va;
    const order: Record<string, number> = { spades: 0, hearts: 1, clubs: 2, diamonds: 3, joker: 4 };
    return order[a.suit] - order[b.suit];
  });
});

const count = computed(() => sortedCards.value.length);
// 牌越多，重叠越多；手牌很少时几乎不重叠
const overlap = computed(() => {
  const n = count.value;
  if (n <= 8) return -18;
  if (n <= 14) return -30;
  return -40;
});

// 弧线布局：越靠边的牌越往下、越倾斜
function cardStyle(i: number) {
  if (props.flat) {
    // 横排：仅做轻微纵向叠压，不旋转不倾斜
    return {
      marginLeft: i === 0 ? "0" : `${Math.min(-6, overlap.value)}px`,
      transform: "none",
      zIndex: i,
    };
  }
  const n = count.value;
  const mid = (n - 1) / 2;
  const dist = i - mid;
  const rot = dist * 1.1;
  const dy = Math.abs(dist) * Math.abs(dist) * 0.55;
  return {
    marginLeft: i === 0 ? "0" : `${overlap.value}px`,
    transform: `rotate(${rot}deg) translateY(${dy}px)`,
    zIndex: i,
  };
}
</script>

<template>
  <div class="flex min-h-[104px] items-end justify-center px-4 pb-0.5">
    <div
      v-for="(card, i) in sortedCards"
      :key="card.id"
      class="origin-bottom transition-transform"
      :style="cardStyle(i)"
    >
      <CardComp
        :card="card"
        :selected="selectedIds.has(card.id)"
        :disabled="disabled"
        @toggle="emit('toggle', card.id)"
        size="lg"
      />
    </div>
  </div>
</template>
