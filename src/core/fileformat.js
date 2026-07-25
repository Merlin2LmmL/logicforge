// LogicForge Circuit file format (.lgf)
//
// A .lgf file is JSON. It is always self-contained: any custom ("Meine Komponenten")
// component types the circuit depends on - recursively - are embedded in `definitions`,
// so opening the file on a machine that has never seen those components still works.
//
// Envelope:
// {
//   "format": "logicforge-circuit", "formatVersion": 1,
//   "kind": "circuit" | "component",
//   "meta": { name, author, description, created, modified },
//   "circuit": <plain circuit>,           // kind === 'circuit'
//   "definition": <definition, sans circuit field duplicated into definitions[0]>,  // kind === 'component'
//   "definitions": [ <definition>, ... ]  // dependency closure, composite defs embed their own plain circuit
// }

import { Circuit } from './model.js';
import { collectDependencies, getDefinition, installDefinition, circuitToPlain } from './library.js';

export const FORMAT_ID = 'logicforge-circuit';
export const FORMAT_VERSION = 1;

function nowIso() { return new Date().toISOString(); }

export function serializeCircuit(circuit, meta = {}) {
  const deps = collectDependencies(circuit);
  const envelope = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    kind: 'circuit',
    meta: { name: meta.name || 'Unbenannte Schaltung', author: meta.author || '', description: meta.description || '', created: meta.created || nowIso(), modified: nowIso() },
    circuit: circuitToPlain(circuit),
    definitions: [...deps.values()],
  };
  return JSON.stringify(envelope, null, 2);
}

export function deserializeCircuit(jsonText) {
  const envelope = JSON.parse(jsonText);
  validateEnvelope(envelope);
  for (const def of envelope.definitions || []) installDefinition(def);
  const circuit = envelope.kind === 'component'
    ? Circuit.fromPlain(envelope.definition.circuit || { components: [], wires: [] })
    : Circuit.fromPlain(envelope.circuit);
  return { circuit, meta: envelope.meta || {}, kind: envelope.kind };
}

export function serializeComponent(definitionId, meta = {}) {
  const def = getDefinition(definitionId);
  if (!def) throw new Error('unbekannte Komponente: ' + definitionId);
  const deps = new Map();
  if (def.kind === 'composite') collectDependencies(Circuit.fromPlain(def.circuit), deps);
  deps.delete(def.id);
  const envelope = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    kind: 'component',
    meta: { name: meta.name || def.name, author: meta.author || '', description: meta.description || '', created: meta.created || nowIso(), modified: nowIso() },
    definition: def,
    definitions: [def, ...deps.values()],
  };
  return JSON.stringify(envelope, null, 2);
}

export function importComponentFile(jsonText) {
  const envelope = JSON.parse(jsonText);
  validateEnvelope(envelope);
  if (envelope.kind !== 'component') throw new Error('Datei enthält keine einzelne Komponente (kind != component)');
  for (const def of envelope.definitions || [envelope.definition]) installDefinition(def);
  return envelope.definition.id;
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.format !== FORMAT_ID) {
    throw new Error('Keine gültige LogicForge-Datei (.lgf) - fehlendes/falsches "format" Feld');
  }
  if (envelope.formatVersion > FORMAT_VERSION) {
    console.warn(`LogicForge: Datei hat neuere formatVersion (${envelope.formatVersion}) als dieser Editor (${FORMAT_VERSION}). Es wird trotzdem versucht sie zu laden.`);
  }
}

export function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickTextFile(accept = '.lgf,application/json') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return reject(new Error('keine Datei ausgewählt'));
      const reader = new FileReader();
      reader.onload = () => resolve({ text: reader.result, filename: file.name });
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
