/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import ChatWindow from "./ChatWindow";
import { frontendLog, installFrontendErrorLogging } from "./lib/logger";
import "./styles/global.css";

const root = document.getElementById("root");

installFrontendErrorLogging();

// The dedicated chat window is loaded with `?win=chat`. Render the focused
// standalone chat UI instead of the full agent shell in that case.
const isChatWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("win") === "chat";

frontendLog("info", "app.main", "Rendering BetterDesk Agent root", { chatWindow: isChatWindow });

render(() => (isChatWindow ? <ChatWindow /> : <App />), root!);
