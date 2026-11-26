from cosmetics.client.shipSkinSequencingSvc import get_ship_skin_sequencing_svc
from cosmetics.common.ships.skins.sequencing_util import get_maximum_runs_per_job
from cosmetics.common.ships.skins.static_data import sequencing_const
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader
from cosmetics.common.ships.skins.static_data.skin_tier import ShipSkinTierTable
from localization import GetByLabel

component = ComponentsDataLoader.get_component_data(53)
tier = ShipSkinTierTable().get_tier_level(32880, component.points_value)
design = type('Fixture', (object,), dict(tier_level=tier))()
service = get_ship_skin_sequencing_svc()
prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
result = dict(station=session.stationid, typeID=32880, component=53, tier=tier,
              points=component.points_value, binder=[component.sequence_binder_type_id, component.sequence_binder_required_amount],
              runSkills=list(sequencing_const.max_runs_skills),
              maxBatchI=get_maximum_runs_per_job(lambda skill_id: int(skill_id == sequencing_const.max_runs_skills[0])),
              price=[service.get_sequencing_plex_price(design, count)[0] for count in (1, 2)],
              duration=service.get_predicted_job_duration(design)[0],
              labels={key: GetByLabel(prefix + key) for key in ('FinalizeDesign', 'CreateSKIN', 'SkinAmount', 'ConsumablesRequired')})
