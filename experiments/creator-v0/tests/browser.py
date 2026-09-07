"""Actual Chromium UI proof. No app or persistence mocks.

Use --html for an in-memory, opaque-origin run (native storage unavailable).
Use --url on a normal local server to additionally verify native reload persistence.
Dependencies: playwright and Pillow; an installed Chromium executable.
"""
from __future__ import annotations
import argparse, json, shutil, sys
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ap=argparse.ArgumentParser()
src=ap.add_mutually_exclusive_group(required=True)
src.add_argument('--html',type=Path);src.add_argument('--url')
ap.add_argument('--out',type=Path,required=True)
ap.add_argument('--executable',default=shutil.which('chromium') or shutil.which('google-chrome'))
a=ap.parse_args();a.out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];console_errors=[]
def check(label,condition):
    assert condition,label
    checks.append(label)
def fixture(path,second=False):
    im=Image.new('RGB',(1600,1000),'#ded9cf');d=ImageDraw.Draw(im)
    d.rectangle((0,0,60,60),fill='#ed3131');d.rectangle((1540,0,1599,60),fill='#16972a')
    d.rectangle((0,940,60,999),fill='#1744bf');d.rectangle((1540,940,1599,999),fill='#111111')
    d.ellipse((350,60,1250,960),fill=('#77b9d2' if second else '#e98bae'),outline='#513b50',width=22)
    d.text((630,430),'SYNTHETIC PHOTO FIXTURE',fill='#1b1825',font_size=28)
    d.text((630,470),'B' if second else 'A',fill='#1b1825',font_size=70)
    im.save(path)
fixture(a.out/'photo-fixture-a.png');fixture(a.out/'photo-fixture-b.png',True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=a.executable,headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1536,'height':1000},accept_downloads=True,device_scale_factor=1)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:console_errors.append(m.text) if m.type=='error' else None)
    page.on('dialog',lambda dialog:dialog.accept())
    if a.url:page.goto(a.url,wait_until='load')
    else:page.set_content(a.html.read_text(),wait_until='load')
    page.wait_for_function("document.documentElement.dataset.appReady==='true'")
    def state():return json.loads(page.locator('#state-inspector').text_content())
    def doc():return state()['document']
    def action(name,id=None):
        q=f'[data-action="{name}"]'+(f'[data-id="{id}"]' if id else '')
        page.locator(q).first.click()
    def shot(name):
        if page.locator('#toast').is_visible():page.locator('#toast').wait_for(state='hidden',timeout=6500)
        page.screenshot(path=str(a.out/name),full_page=True)
    def download(action_name,name):
        with page.expect_download(timeout=20000) as task:action(action_name)
        task.value.save_as(a.out/name)
        return a.out/name
    try:
        check('seeded shelf has five discs',page.locator('.collection-item').count()==5)
        check('initial battle has three blank scores, no highlight or winner',len(doc()['battle']['entries'])==3 and not any(e['score'] for e in doc()['battle']['entries']) and doc()['battle']['highlightedEntryId'] is None and doc()['battle']['winnerEntryId'] is None)
        if not a.url:check('opaque-origin storage failure is explicitly shown, not falsely Saved','Not saved' in page.locator('#save-status').inner_text())
        page.locator('.score-input').nth(0).fill('8.25');page.locator('.score-input').nth(1).fill('-2.5');page.locator('.score-input').nth(2).fill('9')
        check('manual decimal and negative scores retained',[e['score'] for e in doc()['battle']['entries']]==['8.25','-2.5','9'])
        check('scores do not infer winner or highlight',doc()['battle']['winnerEntryId'] is None and doc()['battle']['highlightedEntryId'] is None)
        action('highlight','entry-2');action('winner','entry-0');action('select-disc','zone-peach')
        check('editing focus, highlight, and winner remain independent',state()['editorOnly']['selectedDiscId']=='zone-peach' and doc()['battle']['highlightedEntryId']=='entry-2' and doc()['battle']['winnerEntryId']=='entry-0')
        action('add-entry','luna-sky')
        check('four-card composition prevents accidental fifth add',len(doc()['battle']['entries'])==4 and page.locator('.collection-add:not([disabled])').count()==0)
        action('move-right','entry-0')
        check('reorder keeps entry score and emphasis identity',doc()['battle']['entries'][1]['id']=='entry-0' and doc()['battle']['entries'][1]['score']=='8.25' and doc()['battle']['winnerEntryId']=='entry-0')
        shot('02-battle-four-cards.png')
        png=download('export','battle-overlay-1920.png');im=Image.open(png).convert('RGBA')
        check('PNG exported at 1920 x 1080 with transparent canvas',im.size==(1920,1080) and im.getpixel((0,0))[3]==0 and im.getpixel((960,400))[3]==0 and im.getextrema()[3][1]>0)
        action('clear-highlight');check('clear highlight leaves winner unchanged',doc()['battle']['highlightedEntryId'] is None and doc()['battle']['winnerEntryId']=='entry-0')
        page.locator('[data-mode="card"]').click()
        check('DiscCard uses current selection without inheriting score',doc()['card']['discId']=='luna-sky' and page.locator('#overlay').inner_text().find('8.25')==-1)
        action('new-disc')
        for k,v in dict(manufacturer='Discraft',mold='Buzzz',label='My exact test disc A',plastic='ESP',weight='177 g',speed='5',glide='4',turn='-1.5',fade='1').items():page.locator(f'#disc-form [name="{k}"]').fill(v)
        page.locator('#photo-file').set_input_files(a.out/'photo-fixture-a.png');page.locator('#save-disc').wait_for(state='visible');page.wait_for_function("!document.getElementById('save-disc').disabled")
        page.locator('#save-disc').click();page.wait_for_function("!document.getElementById('disc-dialog').open")
        a_id=doc()['card']['discId'];a_disc=next(d for d in doc()['discs'] if d['id']==a_id)
        check('manual collection add retains exact uploaded photo identity',len(doc()['discs'])==6 and a_disc['photo']['kind']=='upload' and a_disc['label']=='My exact test disc A')
        check('photo resize preserves full aspect ratio',a_disc['photo']['width']==1400 and a_disc['photo']['height']==875)
        check('preview preserves entire uploaded frame without clipping',page.locator('#overlay image').get_attribute('preserveAspectRatio')=='xMidYMid meet' and page.locator('#overlay image').get_attribute('clip-path') is None)
        page.locator('[data-theme="light"]').click();page.locator('#layout-control').select_option('portrait');page.locator('[data-anchor="bottom-right"]').click()
        shot('03-disc-card-uploaded-fixture.png')
        photo_backup=json.loads(download('backup','photo-backup.json').read_text())
        saved_a=next(d for d in photo_backup['discs'] if d['id']==a_id)
        check('downloaded backup contains actual embedded image bytes',saved_a['photo']['dataUrl'].startswith('data:image/webp;base64,') and len(saved_a['photo']['dataUrl'])>1000)
        # Verify all four colored fixture corners survived processing. No crop or invented photo.
        import base64,io
        actual=Image.open(io.BytesIO(base64.b64decode(saved_a['photo']['dataUrl'].split(',')[1]))).convert('RGB')
        corners=[actual.getpixel(p) for p in [(12,12),(1385,12),(12,860),(1385,860)]]
        check('all four source-image corners survive local photo processing',corners[0][0]>180 and corners[1][1]>100 and corners[2][2]>120 and max(corners[3])<65)
        action('another-disc',a_id)
        check('another of this mold reuses facts but clears photo',page.locator('[name="mold"]').input_value()=='Buzzz' and page.locator('#photo-preview image').count()==0 and page.locator('[name="label"]').input_value()=='')
        page.locator('[name="label"]').fill('My exact test disc B');page.locator('#photo-file').set_input_files(a.out/'photo-fixture-b.png');page.wait_for_function("!document.getElementById('save-disc').disabled");page.locator('#save-disc').click()
        b_id=doc()['card']['discId'];check('same mold with different photo remains a separate physical disc',a_id!=b_id and len(doc()['discs'])==7)
        full_backup=json.loads(download('backup','full-backup.json').read_text())
        photos={d['id']:d['photo'] for d in full_backup['discs']}
        check('two same-mold photo bytes do not alias',photos[a_id]['dataUrl']!=photos[b_id]['dataUrl'])
        # Context is optional and never part of transparent output.
        page.locator('#context-file').set_input_files(a.out/'photo-fixture-a.png');page.wait_for_function("document.getElementById('context-image').naturalWidth>0")
        check('local preview image loads behind graphic',page.locator('#context-image').is_visible())
        png=download('export','disc-card-overlay-1920.png');im=Image.open(png).convert('RGBA')
        check('preview background is absent from exported card PNG',im.getpixel((20,20))[3]==0 and im.getpixel((960,500))[3]==0)
        action('clean');check('clean view hides authoring controls',not page.locator('.collection-panel').is_visible());shot('04-clean-view-fixture.png');page.locator('.back-to-editor').click()
        action('clear-context')
        # Alter then restore using the actual file input. Bad backup must not replace the shelf.
        action('delete-disc',b_id);check('delete removes only selected physical instance',len(doc()['discs'])==6 and any(d['id']==a_id for d in doc()['discs']))
        bad=a.out/'bad-backup.json';bad.write_text('{"schemaVersion":999}')
        page.locator('#restore-file').set_input_files(bad);page.wait_for_timeout(100)
        check('invalid backup does not replace collection',len(doc()['discs'])==6 and page.locator('#toast').get_attribute('data-error')=='true')
        page.locator('#restore-file').set_input_files(a.out/'full-backup.json');page.wait_for_function("JSON.parse(document.getElementById('state-inspector').textContent).document.discs.length===7")
        check('actual backup restore returns discs and composition',doc()['card']['discId']==b_id and doc()['presentation']['cardLayout']=='portrait')
        # Native persistence is a separate, positive-origin proof: includes uploaded photos.
        native=False
        if a.url:
            page.wait_for_function("document.getElementById('save-status').textContent==='Saved on this browser'")
            before=doc();page.reload();page.wait_for_function("document.documentElement.dataset.appReady==='true'")
            check('native IndexedDB survives real page reload with uploaded discs',doc()==before)
            reloaded=json.loads(download('backup','reloaded-backup.json').read_text())
            check('native reload retains the actual uploaded image bytes',reloaded==full_backup);native=True
        page.locator('#disc-search').fill('My exact test');check('shelf search distinguishes physical instances',page.locator('.collection-item').count()==2);page.locator('#disc-search').fill('')
        action('edit-disc',b_id);page.keyboard.press('Escape');check('Escape closes edit dialog',not page.locator('#disc-dialog').evaluate('(e)=>e.open'))
        page.set_viewport_size({'width':390,'height':844});page.locator('[data-mode="battle"]').click();page.locator('#layout-control').select_option('stack')
        check('mobile viewport has no horizontal document overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        shot('05-mobile-workbench.png');page.set_viewport_size({'width':1536,'height':1000})
        # Restore a simple, visually legible demo for the final overview image.
        action('reset-demo');page.locator('.score-input').nth(0).fill('8.2');page.locator('.score-input').nth(1).fill('7.5');page.locator('.score-input').nth(2).fill('8.8');action('highlight','entry-2')
        shot('01-workbench.png');download('export','disc-battle-three-1920.png')
        # Empty shelf proof. Samples can be explicitly restored afterward, not silently reseeded.
        for d in list(doc()['discs']):action('select-disc',d['id']);action('delete-disc',d['id'])
        check('empty collection is usable, with export disabled',len(doc()['discs'])==0 and page.locator('[data-action="export"]').is_disabled() and 'empty' in page.locator('#collection-list').inner_text())
        check('no uncaught browser exceptions',not errors)
        report={'passed':len(checks),'checks':checks,'pageErrors':errors,'consoleErrors':console_errors,'mode':'real origin' if a.url else 'in-memory HTML; opaque origin','nativeIndexedDBVerified':native,'browser':browser.version,'viewportChecks':[[1536,1000],[390,844]],'photoEvidence':'Synthetic raster fixtures, not real owner-disc photos. Full-frame image fidelity tested.','exportEvidence':'Actual UI downloads; 1920x1080 PNG transparency and JSON contents checked.'}
        (a.out/'browser-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
    except Exception as e:
        shot('FAILED.png');(a.out/'browser-failure.json').write_text(json.dumps({'error':str(e),'passed':checks,'pageErrors':errors,'consoleErrors':console_errors},indent=2));raise
    finally:browser.close()
