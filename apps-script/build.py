# Builds apps-script/Code.gs = src/gas.js (settings + Apps Script code) + src/mail.js (email helpers).
import re, pathlib
root = pathlib.Path(__file__).resolve().parent
gas = (root / 'src' / 'gas.js').read_text()
mail = (root / 'src' / 'mail.js').read_text()
mail = re.sub(r"^/\*.*?\*/\s*", "", mail, flags=re.S)          # drop file header comment
mail = mail.replace("'use strict';\n", "")
mail = re.sub(r"\nmodule\.exports = .*\n?$", "\n", mail)
out = gas.rstrip() + "\n\n/* =========================================================\n   Email helpers (from src/mail.js)\n   ========================================================= */\n" + mail
(root / 'Code.gs').write_text(out)
print('Code.gs written:', len(out), 'bytes')
