import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { bootstrapStore } from "./store";

// 先把持久化（SQLite / localStorage）里的数据灌进 store 再挂载，
// 避免首屏先渲染默认值再闪一下真实数据。
// 用 finally 兜底：即使持久化失败（隐私模式等）也要把界面起来，只是不落盘。
bootstrapStore().finally(() => {
  createApp(App).mount("#app");
});
