# Publier ThermoPlan 2.12.1

## 1. Sur GitHub (dépôt existant chrisdecagnes/ThermoPlan, avec GitHub Desktop)

1. Dans GitHub Desktop : **File → Clone repository**, choisissez `chrisdecagnes/ThermoPlan` et notez le dossier local (ex. `Documents\GitHub\ThermoPlan`).
2. Décompressez `thermoplan-2.12.1-github.zip`, ouvrez le dossier `ThermoPlan` qu'il contient, sélectionnez **tout son contenu** (Ctrl+A) et copiez-le dans le dossier cloné, en acceptant de **remplacer** `README.md`. Pour voir `.github`, `.gitignore` et `.homeyignore` dans l'Explorateur : **Affichage → Afficher → Éléments masqués**.
3. Onglet **Changes** de GitHub Desktop : environ 95 fichiers, tous cochés.
4. **Summary** : `ThermoPlan v2.12.1`, puis **Commit to main** et **Push origin**.
5. Sur github.com : **Settings → General → Danger Zone → Change visibility → Make public**. Le dépôt doit être public : l'app d'origine est sous GPL-3.0 et `app.json` pointe vers https://github.com/chrisdecagnes/ThermoPlan.
6. Onglet **Actions** : les tests se lancent (Node 18, 20 et 22).
7. **Releases → Draft a new release** : tag `v2.12.1`, titre `ThermoPlan 2.12.1`, texte = contenu de `docs/RELEASE-2.12.1.md`. Vous pouvez joindre `thermoplan-2.12.1-homey-store.zip`.

## 2. Sur le Homey App Store

Depuis le dossier cloné, dans PowerShell (Node.js 18 ou plus) :

```powershell
npm install -g homey
npm install
homey login
homey app validate --level publish
homey app run          # facultatif : essai sur votre Homey Pro, logs en direct
homey app publish
```

- Quand `homey app publish` propose d'augmenter la version, répondez **Non** : elle est déjà à 2.12.1 dans `app.json` et `package.json`.
- Suivez ensuite la soumission sur [tools.developer.homey.app](https://tools.developer.homey.app) : la version arrive en **Test** (installable par lien), puis passez-la en **Live** pour la relecture d'Athom.
- Si `homey app validate` signale un problème sur les images d'aperçu du widget (`widgets/thermoplan/preview-*.png`, 1024×1024 transparent), remplacez-les avec `npm run previews` après ajustement de `bench/check.js`.

## 3. Versions suivantes

Modifiez le code, puis mettez à jour la version dans `scripts/compose-src.py` et `package.json`, ajoutez l'entrée dans `.homeychangelog.json` (fr/en/nl/de) et `CHANGELOG.md`, lancez `npm run compose` et `npm test`, puis **Commit to main**, **Push origin** et `homey app publish`.
