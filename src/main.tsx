// フォントはローカル同梱(fontsource)。実行時に外部への参照を持たない(§3)。
import "@fontsource/biz-udpgothic/400.css";
import "@fontsource/biz-udpgothic/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/ops.css";
import "./styles/ops-v3.css";

import ReactDOM from "react-dom/client";
import { Root } from "./app/Root";

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);
