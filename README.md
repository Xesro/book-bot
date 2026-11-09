# Books Bot

Bot Telegram prive qui recherche des livres autorises dans le catalogue Fourtoutici et les envoie
par e-mail apres verification de l'adresse du destinataire.

## Fonctionnement

1. L'utilisateur ouvre un lien Telegram prive et touche **Demarrer**.
2. Le bot demande une adresse e-mail et envoie un code a 6 chiffres.
3. Une fois l'adresse verifiee, l'utilisateur envoie un titre et un auteur.
4. Le bot interroge les fournisseurs configures et propose jusqu'a cinq EPUB/PDF. Pour chaque
   resultat, il essaie d'abord la couverture exacte du fournisseur, puis une couverture trouvee
   chez un autre fournisseur, et enfin Open Library.
5. Le fichier choisi est telecharge temporairement, valide, envoye par e-mail puis supprime.

Le bot n'est prevu que pour les ouvrages dont le telechargement et la redistribution sont autorises.

## Prerequis

- Node.js 22.17 ou plus recent (Node.js 26 LTS recommande en production)
- pnpm 12
- un bot cree avec [@BotFather](https://t.me/BotFather)
- un compte SMTP capable d'envoyer des pieces jointes

## Installation

```sh
pnpm install
cp .env.example .env
```

Generez les secrets locaux :

```sh
openssl rand -base64 32
openssl rand -base64 32
openssl rand -hex 24
```

Placez les deux premieres valeurs dans `EMAIL_ENCRYPTION_KEY` et `OTP_HMAC_SECRET`. Placez la
troisieme dans `BOT_INVITE_TOKEN`, puis renseignez Telegram et SMTP dans `.env`.

Lancez le bot :

```sh
pnpm dev
```

Apres le premier demarrage, partagez ce lien uniquement avec les personnes autorisees :

```text
https://t.me/NOM_DU_BOT?start=BOT_INVITE_TOKEN
```

Chaque compte qui utilise le bon jeton est inscrit et configure sa propre adresse e-mail. Le jeton
ne doit donc jamais etre publie : toute personne qui possede le lien peut rejoindre le bot.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Logs de diagnostic

Pour suivre les recherches et comprendre pourquoi une couverture n'apparait pas, utilisez :

```env
LOG_LEVEL=debug
```

Puis redemarrez et suivez les logs :

```sh
docker compose up -d
docker compose logs -f books-bot
```

Les evenements `book_search_*` et `catalog_search_*` decrivent la recherche Fourtoutici,
`provider_cover_*` les images des catalogues, `cover_*` la recherche Open Library et
`telegram_cover_*` le chargement puis l'affichage de l'image. Remettez `LOG_LEVEL=info` puis
redemarrez pour masquer ces details.

## Ajouter un fournisseur

Un fournisseur implemente l'interface `BookProvider` de `src/sources/types.ts` avec un identifiant
unique, une recherche et un telechargement. Chaque resultat conserve `providerId` pour que le
telechargement soit toujours renvoye au bon service, et peut fournir `providerCoverUrl`. Ajoutez
ensuite l'instance au tableau transmis a `BookCatalogService` dans `src/index.ts`.

Le catalogue agrege automatiquement les resultats, peut reutiliser une couverture correspondante
venant d'un autre fournisseur et ne consulte les sources publiques de secours qu'en dernier.

## Docker

Apres avoir configure `.env` :

```sh
docker compose up --build -d
```

La base SQLite est conservee dans le volume `books-bot-data`. Les fichiers livres sont uniquement
stockes dans un repertoire temporaire pendant leur envoi.

## Commandes Telegram

- `/email` ou `/changer_email` : configurer une nouvelle adresse
- `/annuler` : annuler la verification en cours
- `/supprimer_email` : effacer l'adresse enregistree
- `/aide` : afficher l'aide
