"""Build the designed frame sheet and preserve capture hashes; Pillow is required."""
from pathlib import Path
from PIL import Image,ImageDraw
import hashlib,json
ROOT=Path(__file__).resolve().parent.parent
names=['opening','proof','payoff','close']
sheet=Image.new('RGB',(1280,776),'#fafafa');draw=ImageDraw.Draw(sheet)
for i,name in enumerate(names):
    img=Image.open(ROOT/'storyboard'/f'{name}.png').convert('RGB');img.thumbnail((640,360))
    x=(i%2)*640;y=(i//2)*388;sheet.paste(img,(x,y));draw.text((x+18,y+363),name,fill='#333333')
sheet.save(ROOT/'storyboard'/'storyboard-sheet.jpg',quality=94)
records=[]
for f in sorted((ROOT/'captures').glob('*.png')):
    records.append({'file':str(f.relative_to(ROOT)),'dimensions':Image.open(f).size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
(ROOT/'review'/'capture-inventory.json').write_text(json.dumps(records,indent=2)+'\n')
