from localization import GetByLabel
from sovereignty.mercenaryden.client.ui.containers.evolution_progression import (
    AnarchyProgressionContainer, BaseEvolutionProgressionContainer, DevelopmentProgressionContainer,
)
from sovereignty.mercenaryden.client.ui.containers.evolution_title import AnarchyTitleContainer, DevelopmentTitleContainer

class SampleController(object):
    def get_infomorph_generation_rates_per_second(self, stage):
        return (68.0 / 3600, 105.0 / 3600)

    def get_workforce_cost_as_percentage(self, stage):
        return 10.0

progress = GetByLabel(BaseEvolutionProgressionContainer.LABEL_PATH_LEVEL_PROGRESS,
                      current_level=2, level_upper_band=20)
sample = SampleController()
result = dict(station=session.stationid, progress=progress,
              development=DevelopmentProgressionContainer._get_hint.im_func(DevelopmentProgressionContainer, sample, 1, progress),
              anarchy=AnarchyProgressionContainer._get_hint.im_func(AnarchyProgressionContainer, sample, 2, progress),
              developmentTitle=GetByLabel(DevelopmentTitleContainer.LABEL_PATH_TOOLTIP, current_rate='68-105/h'),
              anarchyTitle=GetByLabel(AnarchyTitleContainer.LABEL_PATH_TOOLTIP, workforce_cost='10%'))
