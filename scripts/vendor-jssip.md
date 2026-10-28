# Сборка бандла JsSIP для «Телефона»

JsSIP (MIT) в npm лежит только как CommonJS, поэтому его собирают esbuild в один
ESM-файл `public/js/vendor/jssip-3.13.9.mjs`. Сборка идёт во временной папке вне
репозитория; в проект попадают только готовый файл и лицензия.

```bash
mkdir jssip-build && cd jssip-build
npm init -y
npm install --no-audit --no-fund jssip@3.13.9 events@3.3.0 esbuild@0.24.0
printf "import JsSIP from 'jssip';\nexport default JsSIP;\nexport const { UA, WebSocketInterface, version } = JsSIP;\n" > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof --outfile=jssip-3.13.9.mjs
cp jssip-3.13.9.mjs <проект>/public/js/vendor/
cp node_modules/jssip/LICENSE.md <проект>/public/js/vendor/jssip-LICENSE.md
```

Проверка: `node --test public/js/vendor/__tests__/jssip-bundle.test.mjs`.

Бандл собран 2026-10-29 из jssip@3.13.9 (MIT); пересобирать теми же командами при смене версии.
