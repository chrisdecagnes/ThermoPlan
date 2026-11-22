# Historique des versions

Format : version — description (français). Le fichier `.homeychangelog.json` contient les textes du store en fr/en/nl/de.

## 2.12.1

Widget : correction d’un widget pouvant rester vide sur certaines versions de Homey (ajustement de la hauteur). Les initiales des jours des plages suivent la langue de Homey.

## 2.12.0

Traductions néerlandaise et allemande (page de réglages, widget, cartes Flow, description du store). Virgule décimale en français, néerlandais et allemand.

## 2.11.0

Widget du tableau de bord : chaque programme affiche maintenant un mini-graphique « Dernières 24 heures » (température mesurée, consigne, extérieur), désactivable dans les réglages du widget.

## 2.10.0

Aperçu : nouveau graphique « Dernières 24 heures » par programme avec la température mesurée, la consigne et la température extérieure (un point toutes les 10 minutes).

## 2.9.0

Ventilation selon la température de la pièce : un programme de ventilation peut utiliser une sonde pour ne tourner qu'au-dessus d'un seuil choisi (avec marge). Nouveau déclencheur Flow « La température extérieure moyenne a changé ».

## 2.8.1

Fenêtre ouverte : choix entre couper tout le programme quand une porte ou une fenêtre est ouverte dans l'une de ses zones, ou seulement les appareils de la pièce concernée.

## 2.8.0

Personne à la maison : toutes les programmations se mettent en pause quand tous les utilisateurs Homey sont absents (après un délai choisi) et reprennent au retour. Chauffage arrêté ou réduit, clim et ventilation arrêtées. Cartes Flow pour forcer ou suivre la présence.

## 2.7.0

Programmes de ventilation : boutons de vitesse (Arrêt, 1…N, Auto, Silence) lus sur le ventilateur, ou curseur en % pour les ventilateurs à variateur.

## 2.6.0

Ventilation de la clim par plage horaire : inchangée, Auto, Silence ou un niveau fixe (1 à 5 sur les Daikin), appliquée avec la température.

## 2.5.0

Sonde de la pièce par programme : affichage de la vraie température de la pièce, ou régulation par ThermoPlan (chauffage / climatisation en marche ou en attente autour de la consigne, avec une marge réglable).

## 2.4.1

Les interrupteurs et les libellés s'affichent maintenant correctement sur Homey.

## 2.4.0

Fenêtre ouverte : le chauffage ou la climatisation s'arrête quand une fenêtre de la zone reste ouverte plus longtemps que le délai choisi (capteurs de la zone de l'appareil ou capteurs choisis), puis reprend son programme à la fermeture. Notification au choix.

## 2.3.1

Page de réglages revue : l'apparence ne change plus une fois sur Homey (styles isolés), nouvel aperçu avec boutons de mode et de saison et cartes de programmes montrant les plages du jour, style homogène sur tous les onglets.

## 2.3.0

Nouveau widget de tableau de bord : mode et saison en un coup d'œil, chaque programme avec sa valeur actuelle, ses plages du jour, un interrupteur et les boutons Tester / Revenir au programme. Nécessite un Homey Pro (2023) en version 12.3 ou plus.

## 2.2.0

Nouvel éditeur de programme : graphique de la semaine, plages horaires avec boutons de jours (Lun–Ven, week-end, tous les jours), valeur hors plages, boutons +/− pour la température, boutons Tester pour essayer un programme tout de suite, période de validité. Les programmes existants sont convertis automatiquement.

## 2.1.0

Saison selon la température extérieure (toute sonde, y compris la température extérieure remontée par un climatiseur), avec seuils été / mi-saison / hiver. Les climatiseurs aux noms de modes propres à la marque (ex. Daikin « cooling » / « heating ») passent maintenant dans le bon mode. Nouveau jeton Flow : température extérieure moyenne.

## 2.0.0

Réécriture complète pour le SDK 3 de Homey : programmes de climatisation et de ventilation, saisons été/hiver, traduction française.
