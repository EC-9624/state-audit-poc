import { atom } from "jotai";

export const counterAtom = atom(0);

export const counterLabelAtom = atom((get) => `value:${get(counterAtom)}`);
