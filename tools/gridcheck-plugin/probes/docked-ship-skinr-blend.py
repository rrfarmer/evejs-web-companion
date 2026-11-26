import evegraphics.utils as gfxutils
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from cosmetics.common.ships.skins.static_data.pattern_blend_mode import NO_SECONDARY_COLOR_BLEND_MODES
from eve.client.script.environment.spaceObject.cosmeticsConst import BLEND_MODE
from eve.client.script.environment.spaceObject.cosmeticsManager import CosmeticsManager
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
model = sm.GetService('sofService').spaceObjectFactory.BuildFromDNA(gfxutils.BuildSOFDNAFromTypeID(32880))
design = SkinDesign(session.charid)
design.ship_type_id = 32880
design.fit_slot(5, 179)
design.fit_slot(7, 180)
design.fit_slot(8, 53)
modes = []
for mode, key in enumerate(('Normal', 'Subtractive', 'Exclusion', 'Nested', 'NestedInverted'), 1):
    design.slot_layout.pattern_blend_mode = mode
    CosmeticsManager.SetBlendMode(model, mode)
    modes.append(dict(id=mode, label=GetByLabel(prefix + 'BlendMode/' + key),
                      option=BLEND_MODE[mode], usesSecondaryMaterial=mode not in NO_SECONDARY_COLOR_BLEND_MODES,
                      retainedMaterial=design.get_fitted_component_instance(8).component_id))
result = dict(station=session.stationid, ship=design.ship_type_id, menu=GetByLabel(prefix + 'BlendModes'), modes=modes)
