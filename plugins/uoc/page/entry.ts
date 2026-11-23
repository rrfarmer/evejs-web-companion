import {mount} from "svelte";
import StandalonePage from "./StandalonePage.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Operations Center page is unavailable.");
mount(StandalonePage, { target });
