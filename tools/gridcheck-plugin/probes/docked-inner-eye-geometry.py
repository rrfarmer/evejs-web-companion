import blue
import re

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.paperDoll.paperDollSculpting import PaperDollSculpting
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow, SculptingRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    sculptor = KeyVal()
    PaperDollSculpting.LoadMapping.im_func(sculptor)
    PaperDollSculpting.LoadFieldData.im_func(sculptor)
    authored = sorted(name for name in sculptor.fieldData['Fields'] if name.lower().startswith('eyesinner'))
    PaperDollSculpting.FillInFieldData.im_func(sculptor)
    fallback = {name: list(field['Attributes']) for name, field in sculptor.fieldData['Fields'].iteritems()
                if name.lower().startswith('eyesinner')}
    rows = []
    for gender in (0, 1):
        pilot = next(char_id for char_id, info in iter_npc_characters()
                     if info.gender == gender and info.bloodlineID == 8)
        for direction in (-1, 1):
            weights = [0.25 * direction] * 3
            dna = KeyVal(appearance=AppearanceRow(0.5), sculpts=[SculptingRow(21, *weights), SculptingRow(20, *weights)],
                         colors=[], modifiers=[])
            try:
                window = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
                for _ in range(80):
                    context = window.previewContainer.context
                    if context and context.character is not None and getattr(context, 'boundingBox', None):
                        break
                    blue.synchro.SleepWallclock(100)
                if not context or not getattr(context, 'boundingBox', None):
                    raise RuntimeError('Character preview did not report bounds')
                doll = context.character.doll
                requested = sorted(name for name in doll.buildDataManager.GetMorphTargets()
                                   if name.lower().startswith(('eyesinner_', 'eyesouter_')))
                caches = []
                for mesh, (_, geometry, names) in doll.blendShapeMeshCache.iteritems():
                    targets = sorted(set(re.sub(r'\d+$', '', name.lower()) for name in names
                                         if name.lower().startswith(('eyesinner_', 'eyesouter_'))))
                    if targets:
                        caches.append(dict(mesh=mesh, targets=targets))
                rows.append(dict(gender=gender, direction=direction, requested=requested, meshes=caches))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, authored=authored, fallback=fallback, rows=rows)


result = observe()
