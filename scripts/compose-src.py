#!/usr/bin/env python3
"""Génère les fichiers .homeycompose (source de vérité pour app.json).

Exécuter une fois après modification : python3 scripts/compose-src.py
Puis `homey app build` (ou scripts/compose.py hors ligne) génère app.json.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = os.path.join(ROOT, '.homeycompose')
VERSION = '2.12.1'


with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'i18n-nl-de.json'), encoding='utf-8') as _f:
    NL_DE = json.load(_f)  # { anglais: [nl, de] }
MISSING = set()


def t(en, fr):
    """Texte multilingue : fr et en fournis, nl et de pris dans i18n-nl-de.json (repli sur l'anglais)."""
    out = {'en': en, 'fr': fr}
    tr = NL_DE.get(en)
    if tr is None:
        MISSING.add(en)
    else:
        out['nl'], out['de'] = tr
    return out


def write(path, data):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


MODES = [
    ('0', t('Automatic', 'Automatique')),
    ('1', t('One day at home', 'Journée à la maison')),
    ('2', t('One day away from home', 'Journée d’absence')),
    ('3', t('Sleeping', 'Nuit')),
    ('4', t('Holiday', 'Vacances')),
    ('5', t('Out of season', 'Hors saison')),
]
SEASONS_SET = [
    ('auto', t('Automatic (by date)', 'Automatique (selon les dates)')),
    ('outdoor', t('By outdoor temperature', 'Selon la température extérieure')),
    ('heating', t('Winter (heating)', 'Hiver (chauffage)')),
    ('cooling', t('Summer (cooling & fans)', 'Été (climatisation et ventilation)')),
    ('off', t('Mid-season (nothing controlled)', 'Mi-saison (aucun pilotage)')),
]
SEASONS = [
    ('heating', t('Winter (heating)', 'Hiver (chauffage)')),
    ('cooling', t('Summer (cooling & fans)', 'Été (climatisation et ventilation)')),
    ('off', t('Mid-season', 'Mi-saison')),
]
TMODES = [
    ('0', t('Schedule (automatic)', 'Programme (automatique)')),
    ('6', t('Manual until midnight', 'Manuel jusqu’à minuit')),
    ('7', t('Fully manual', 'Entièrement manuel')),
]
ONOFF = [('true', t('enabled', 'activé')), ('false', t('disabled', 'désactivé'))]


def values(lst):
    return [{'id': i, 'label': l} for i, l in lst]


PLAN_ARG = {
    'type': 'autocomplete', 'name': 'plan', 'title': t('Schedule', 'Programme'),
    'placeholder': t('Search for a schedule...', 'Rechercher un programme...'),
}

app = {
    'id': 'fr.cpistre.thermoplan',
    'version': VERSION,
    'compatibility': '>=12.3.0',  # widgets : Homey Pro (2023) et plus récent
    'sdk': 3,
    'platforms': ['local'],
    'name': t('ThermoPlan', 'ThermoPlan'),
    'description': t(
        'Heating, air conditioning and fans, season by season',
        'Chauffage, climatisation et ventilation, au fil des saisons'),
    'category': ['climate'],
    'tags': {
        'en': ['heating', 'thermostat', 'schedule', 'air conditioning', 'cooling', 'fan', 'climate', 'outdoor temperature'],
        'fr': ['chauffage', 'thermostat', 'programmation', 'climatisation', 'ventilateur', 'clim', 'planning', 'température extérieure'],
        'nl': ['verwarming', 'thermostaat', 'schema', 'airconditioning', 'koeling', 'ventilator', 'airco', 'buitentemperatuur'],
        'de': ['Heizung', 'Thermostat', 'Zeitplan', 'Klimaanlage', 'Kühlung', 'Ventilator', 'Klima', 'Außentemperatur'],
    },
    'permissions': ['homey:manager:api'],
    'brandColor': '#E8590C',
    'images': {
        'small': '/assets/images/small.png',
        'large': '/assets/images/large.png',
        'xlarge': '/assets/images/xlarge.png',
    },
    'author': {'name': 'Christophe Pistre'},
    'contributors': {
        'developers': [{'name': 'Markus Kling (application d’origine homey-heating, GPL-3.0)'}],
    },
    'source': 'https://github.com/chrisdecagnes/ThermoPlan',
    'bugs': {'url': 'https://github.com/chrisdecagnes/ThermoPlan/issues'},
    'support': 'https://github.com/chrisdecagnes/ThermoPlan/issues',
    'api': {
        'getState': {'method': 'GET', 'path': '/state'},
        'getPlans': {'method': 'GET', 'path': '/plans'},
        'getHistory': {'method': 'GET', 'path': '/history'},
        'newPlan': {'method': 'GET', 'path': '/new-plan'},
        'getPlan': {'method': 'GET', 'path': '/plans/:id'},
        'putPlan': {'method': 'PUT', 'path': '/plans/:id'},
        'deletePlan': {'method': 'DELETE', 'path': '/plans/:id'},
        'putPlans': {'method': 'PUT', 'path': '/plans'},
        'testPlan': {'method': 'POST', 'path': '/plans/:id/test'},
        'applyPlan': {'method': 'POST', 'path': '/plans/:id/apply'},
        'putMode': {'method': 'PUT', 'path': '/mode'},
        'putSeason': {'method': 'PUT', 'path': '/season'},
        'applyAll': {'method': 'POST', 'path': '/apply'},
        'getDevices': {'method': 'GET', 'path': '/devices'},
    },
}
write('.homeycompose/app.json', app)

write('.homeycompose/capabilities/thermostat_override.json', {
    'type': 'enum',
    'title': t('Thermostat mode', 'Mode du thermostat'),
    'getable': True,
    'setable': True,
    'uiComponent': 'picker',
    'icon': '/assets/override.svg',
    'values': [{'id': i, 'title': l} for i, l in TMODES],
})

# ---------------------------------------------------------------- Actions
write('.homeycompose/flow/actions/apply_all.json', {
    'title': t('Apply all active schedules', 'Appliquer tous les programmes actifs'),
    'hint': t('Re-sends the current set points to all devices.',
              'Renvoie les consignes en cours à tous les appareils.'),
})
write('.homeycompose/flow/actions/apply_plan.json', {
    'title': t('Apply a schedule', 'Appliquer un programme'),
    'titleFormatted': t('Apply schedule [[plan]]', 'Appliquer le programme [[plan]]'),
    'args': [PLAN_ARG],
})
write('.homeycompose/flow/actions/set_mode.json', {
    'title': t('Set the mode', 'Changer le mode'),
    'titleFormatted': t('Set the mode to [[mode]]', 'Passer en mode [[mode]]'),
    'args': [{'type': 'dropdown', 'name': 'mode', 'title': t('Mode', 'Mode'), 'values': values(MODES)}],
})
write('.homeycompose/flow/actions/set_season.json', {
    'title': t('Set the season', 'Changer la saison'),
    'titleFormatted': t('Set the season to [[season]]', 'Régler la saison sur [[season]]'),
    'hint': t('Winter runs the heating schedules, summer the cooling and fan schedules.',
              'L’hiver active les programmes de chauffage, l’été ceux de climatisation et de ventilation.'),
    'args': [{'type': 'dropdown', 'name': 'season', 'title': t('Season', 'Saison'), 'values': values(SEASONS_SET)}],
})
write('.homeycompose/flow/actions/set_plan_state.json', {
    'title': t('Enable or disable a schedule', 'Activer ou désactiver un programme'),
    'titleFormatted': t('Set schedule [[plan]] to [[state]]', 'Programme [[plan]] [[state]]'),
    'args': [PLAN_ARG, {'type': 'dropdown', 'name': 'state', 'title': t('State', 'État'), 'values': values(ONOFF)}],
})

write('.homeycompose/flow/actions/set_away.json', {
    'title': t('Set the away mode', 'Régler l’absence'),
    'titleFormatted': t('Away mode: [[state]]', 'Absence : [[state]]'),
    'hint': t('Nobody home pauses every schedule. “Automatic” follows the presence of Homey users.',
              'Personne à la maison met toutes les programmations en pause. « Automatique » suit la présence des utilisateurs Homey.'),
    'args': [{'type': 'dropdown', 'name': 'state', 'title': t('State', 'État'), 'values': values([
        ('auto', t('Automatic (Homey presence)', 'Automatique (présence Homey)')),
        ('away', t('Nobody home (pause)', 'Personne à la maison (pause)')),
        ('home', t('Someone is home', 'Quelqu’un est à la maison')),
    ])}],
})

# ---------------------------------------------------------------- Triggers
write('.homeycompose/flow/triggers/away_started.json', {
    'title': t('Schedules were paused (nobody home)', 'Les programmations sont en pause (personne à la maison)'),
})
write('.homeycompose/flow/triggers/away_ended.json', {
    'title': t('Schedules resumed (someone is home)', 'Les programmations ont repris (retour à la maison)'),
})
write('.homeycompose/flow/triggers/mode_changed.json', {
    'title': t('The mode changed', 'Le mode a changé'),
    'tokens': [{'name': 'mode', 'type': 'string', 'title': t('Mode', 'Mode'), 'example': t('Automatic', 'Automatique')}],
})
write('.homeycompose/flow/triggers/outdoor_average_changed.json', {
    'title': t('The average outdoor temperature changed', 'La température extérieure moyenne a changé'),
    'hint': t('Average over the period set in ThermoPlan, rounded to 0.5 °C. Requires an outdoor sensor.',
              'Moyenne sur la durée réglée dans ThermoPlan, arrondie à 0,5 °C. Nécessite une sonde extérieure.'),
    'tokens': [
        {'name': 'average', 'type': 'number', 'title': t('Average', 'Moyenne'), 'example': 18.5},
        {'name': 'previous', 'type': 'number', 'title': t('Previous average', 'Moyenne précédente'), 'example': 18},
    ],
})
write('.homeycompose/flow/triggers/season_changed.json', {
    'title': t('The season changed', 'La saison a changé'),
    'tokens': [{'name': 'season', 'type': 'string', 'title': t('Season', 'Saison'),
                'example': t('Summer (cooling & fans)', 'Été (climatisation et ventilation)')}],
})

# ---------------------------------------------------------------- Conditions
write('.homeycompose/flow/conditions/mode_is.json', {
    'title': t('The mode is !{{|not}}...', 'Le mode !{{est|n’est pas}}...'),
    'titleFormatted': t('The mode !{{is|is not}} [[mode]]', 'Le mode !{{est|n’est pas}} [[mode]]'),
    'args': [{'type': 'dropdown', 'name': 'mode', 'title': t('Mode', 'Mode'), 'values': values(MODES)}],
})
write('.homeycompose/flow/conditions/season_is.json', {
    'title': t('The season !{{is|is not}}...', 'La saison !{{est|n’est pas}}...'),
    'titleFormatted': t('The season !{{is|is not}} [[season]]', 'La saison !{{est|n’est pas}} [[season]]'),
    'args': [{'type': 'dropdown', 'name': 'season', 'title': t('Season', 'Saison'), 'values': values(SEASONS)}],
})
write('.homeycompose/flow/conditions/away_active.json', {
    'title': t('Schedules !{{are|are not}} paused (nobody home)', 'Les programmations !{{sont|ne sont pas}} en pause (absence)'),
})
write('.homeycompose/flow/conditions/plan_enabled.json', {
    'title': t('A schedule !{{is|is not}} enabled', 'Un programme !{{est|n’est pas}} activé'),
    'titleFormatted': t('Schedule [[plan]] !{{is|is not}} enabled', 'Le programme [[plan]] !{{est|n’est pas}} activé'),
    'args': [PLAN_ARG],
})

# ---------------------------------------------------------------- Driver
write('drivers/virtual-thermostat/driver.compose.json', {
    'name': t('Virtual thermostat', 'Thermostat virtuel'),
    'class': 'thermostat',
    'capabilities': ['target_temperature', 'measure_temperature', 'thermostat_override'],
    'capabilitiesOptions': {
        'target_temperature': {'min': 4, 'max': 35, 'step': 0.5},
    },
    'platforms': ['local'],
    'connectivity': [],
    'images': {
        'small': '{{driverAssetsPath}}/images/small.png',
        'large': '{{driverAssetsPath}}/images/large.png',
        'xlarge': '{{driverAssetsPath}}/images/xlarge.png',
    },
    'pair': [
        {'id': 'list_devices', 'template': 'list_devices', 'navigation': {'next': 'add_devices'}},
        {'id': 'add_devices', 'template': 'add_devices'},
    ],
})
write('drivers/virtual-thermostat/driver.flow.compose.json', {
    'triggers': [{
        'id': 'thermostat_override_changed',
        'title': t('The thermostat mode changed', 'Le mode du thermostat a changé'),
        'tokens': [{'name': 'mode', 'type': 'string', 'title': t('Mode', 'Mode'),
                    'example': t('Manual until midnight', 'Manuel jusqu’à minuit')}],
    }],
    'conditions': [{
        'id': 'thermostat_override_is',
        'title': t('Thermostat mode !{{is|is not}}...', 'Le mode du thermostat !{{est|n’est pas}}...'),
        'titleFormatted': t('Thermostat mode !{{is|is not}} [[mode]]', 'Le mode du thermostat !{{est|n’est pas}} [[mode]]'),
        'args': [{'type': 'dropdown', 'name': 'mode', 'title': t('Mode', 'Mode'), 'values': values(TMODES)}],
    }],
    'actions': [{
        'id': 'set_thermostat_override',
        'title': t('Set the thermostat mode', 'Changer le mode du thermostat'),
        'titleFormatted': t('Set the thermostat mode to [[mode]]', 'Passer le thermostat en [[mode]]'),
        'args': [{'type': 'dropdown', 'name': 'mode', 'title': t('Mode', 'Mode'), 'values': values(TMODES)}],
    }],
})
# ---------------------------------------------------------------- Widget (tableau de bord)
write('widgets/thermoplan/widget.compose.json', {
    'name': t('ThermoPlan', 'ThermoPlan'),
    'height': 320,
    'settings': [
        {'id': 'plan', 'type': 'autocomplete',
         'title': t('Schedule shown (empty = all)', 'Programme affiché (vide = tous)')},
        {'id': 'show_header', 'type': 'checkbox', 'value': True,
         'title': t('Show mode and season', 'Afficher le mode et la saison')},
        {'id': 'show_day', 'type': 'checkbox', 'value': True,
         'title': t('Show today\'s time slots', 'Afficher les plages du jour')},
        {'id': 'show_chart', 'type': 'checkbox', 'value': True,
         'title': t('Show the last 24 hours', 'Afficher les dernières 24 heures')},
        {'id': 'show_disabled', 'type': 'checkbox', 'value': True,
         'title': t('Show disabled schedules', 'Afficher les programmes désactivés')},
    ],
    'api': {
        'getState': {'method': 'GET', 'path': '/state'},
        'getHistory': {'method': 'GET', 'path': '/history'},
        'setMode': {'method': 'PUT', 'path': '/mode'},
        'setPlanEnabled': {'method': 'PUT', 'path': '/plans/:id/enabled'},
        'testPlan': {'method': 'POST', 'path': '/plans/:id/test'},
        'applyPlan': {'method': 'POST', 'path': '/plans/:id/apply'},
        'applyAll': {'method': 'POST', 'path': '/apply'},
    },
})
if MISSING:
    print('Traductions nl/de manquantes (repli anglais) :', *sorted(MISSING), sep='\n  ')
print('ok')
