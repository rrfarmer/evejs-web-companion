import blue

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow, ModifierRow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    location = next(row.modifierLocationID for row in cfg.paperdollModifierLocations if row.modifierKey == 'bottommiddle')
    pilot = next(char_id for char_id, info in iter_npc_characters() if info.gender == 0 and info.bloodlineID == 8)
    observations = []
    for trousers in (None, 55):
        modifiers = [ModifierRow(26, 33, 0), ModifierRow(22, 157, 0), ModifierRow(location, 3471, 0)]
        if trousers:
            modifiers.append(ModifierRow(25, trousers, 0))
        dna = KeyVal(appearance=AppearanceRow(0.5), sculpts=[], colors=[], modifiers=modifiers)
        try:
            window = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
            for _ in range(80):
                context = window.previewContainer.context
                if context and getattr(context, 'boundingBox', None):
                    break
                blue.synchro.SleepWallclock(100)
            if not context or not getattr(context, 'boundingBox', None):
                raise RuntimeError('Character preview did not report bounds')
            doll = context.character.doll
            observations.append(dict(trousers=trousers,
                                     modifiers=sorted(modifier.respath for modifier in doll.buildDataManager.GetModifiersAsList()
                                                      if modifier.categorie in ('bottommiddle', 'bottominner', 'bottomouter', 'feet')),
                                     meshes=sorted(mesh.name for mesh in context.character.avatar.visualModel.meshes)))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, location=location, rows=observations,
                label=GetByLabel('UI/Login/CharacterCreation/AssetMenu/ModifierNames/Clothing/BottomMiddleLayer'))


result = observe()
