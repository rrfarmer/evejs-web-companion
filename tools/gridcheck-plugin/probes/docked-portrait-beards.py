import blue
from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow, ColorSelectionRow, ModifierRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    pilot = next(char_id for char_id, info in iter_npc_characters() if info.gender == 1 and info.bloodlineID == 8)
    slot = next(row.modifierLocationID for row in cfg.paperdollModifierLocations if row.modifierKey == 'beard')
    resources = {row.resPath.lower().split('/')[-1][:-5]: row.paperdollResourceID
                 for row in cfg.paperdollResources if row.resGender == 1 and row.resPath.lower().startswith('beard/')}
    names = {row.colorName: row.colorNameID for row in cfg.paperdollColorNames}
    hair_color = next(row.colorID for row in cfg.paperdollColors if row.colorKey == 'hair')
    rows = []
    for style, darkness in (('beard_01', 0.35), ('beard_07', 1.0), ('fiveoc', 0.5)):
        dna = KeyVal(appearance=AppearanceRow(darkness), sculpts=[],
                     colors=[ColorSelectionRow(hair_color, names['07_a'], names['08_bc'], 0.0, 0.0)],
                     modifiers=[ModifierRow(5, 286, 0), ModifierRow(slot, resources[style], 0)])
        try:
            wnd = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
            for _ in range(80):
                context = wnd.previewContainer.context
                if context and context.character is not None and getattr(context, 'boundingBox', None):
                    break
                blue.synchro.SleepWallclock(100)
            if not context or not getattr(context, 'boundingBox', None):
                raise RuntimeError('Character preview did not report bounds')
            modifiers = context.character.doll.buildDataManager.GetModifiersAsList(showHidden=True)
            rows.append(dict(style=style, darkness=darkness,
                             layers=[dict(path=item.GetResPath(), diffuse=dict(item.mapD), colorize=dict(item.mapL),
                                          zones=dict(item.mapZ), stubble=item.stubblePath, colors=list(item.colorizeData))
                                     for item in modifiers if item.GetResPath().lower().startswith(('hair/', 'beard/'))]))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, slot=slot, resources=resources, rows=rows)


result = observe()
