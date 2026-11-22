#!/usr/bin/env python3
"""Assemble app.json à partir de .homeycompose (équivalent hors ligne de `homey app build`)."""
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


app = load(os.path.join(ROOT, '.homeycompose/app.json'))
caps = {}
for p in sorted(glob.glob(os.path.join(ROOT, '.homeycompose/capabilities/*.json'))):
    caps[os.path.splitext(os.path.basename(p))[0]] = load(p)
if caps:
    app['capabilities'] = caps

flow = {}
for kind in ('triggers', 'conditions', 'actions'):
    for p in sorted(glob.glob(os.path.join(ROOT, f'.homeycompose/flow/{kind}/*.json'))):
        card = {'id': os.path.splitext(os.path.basename(p))[0], **load(p)}
        flow.setdefault(kind, []).append(card)

drivers = []
for d in sorted(glob.glob(os.path.join(ROOT, 'drivers/*/driver.compose.json'))):
    did = os.path.basename(os.path.dirname(d))
    drv = {'id': did, **load(d)}
    raw = json.dumps(drv).replace('{{driverAssetsPath}}', f'/drivers/{did}/assets')
    drivers.append(json.loads(raw))
    fp = os.path.join(os.path.dirname(d), 'driver.flow.compose.json')
    if os.path.exists(fp):
        for kind, cards in load(fp).items():
            for card in cards:
                card = dict(card)
                card['args'] = [{'type': 'device', 'name': 'device',
                                 'filter': f'driver_id={did}'}] + card.get('args', [])
                flow.setdefault(kind, []).append(card)
if drivers:
    app['drivers'] = drivers

widgets = {}
for w in sorted(glob.glob(os.path.join(ROOT, 'widgets/*/widget.compose.json'))):
    widgets[os.path.basename(os.path.dirname(w))] = load(w)
if widgets:
    app['widgets'] = widgets
if flow:
    app['flow'] = flow

with open(os.path.join(ROOT, 'app.json'), 'w', encoding='utf-8') as f:
    f.write('{\n  "_comment": "Ce fichier est généré depuis .homeycompose, ne pas modifier directement.",\n')
    body = json.dumps(app, ensure_ascii=False, indent=2)
    f.write(body[2:])
    f.write('\n')
print('app.json généré')
