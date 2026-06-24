import { zeroGGalileo } from "./chain";

// 0G Galileo block explorer (Chainscan). Used to make every on-chain proof, a tx
// hash or an address, clickable so it can be verified live during a demo.
export const EXPLORER = zeroGGalileo.blockExplorers.default.url;

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER}/address/${addr}`;
