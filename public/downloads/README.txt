Bastion POS Agent — instaladores
=================================

Coloque o instalador aqui com o nome:
  BastionPOSAgent-Setup.exe   (Windows)

Como gerar:
  1. cd desktop
  2. npm install
  3. node build-msi.cjs    (ou @electron/packager para .exe)
  4. Mova o binário para este diretório (public/downloads/)

Como sobrescrever a URL sem hospedar aqui:
  Defina a env VITE_AGENT_INSTALLER_URL apontando para a URL final
  (ex.: GitHub Releases). O botão "Baixar Agente Local" no PDV
  vai usar essa URL em vez do arquivo local.

Este README pode ser removido depois que o binário estiver publicado.
