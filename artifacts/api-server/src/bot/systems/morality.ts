export interface MoralChoice {
  id: string;
  scenario: string;
  options: { key: string; label: string; karma: number; money: number; rep: number; outcome: string }[];
}

export const MORAL_SCENARIOS: MoralChoice[] = [
  {
    id: "idoso",
    scenario: "👴 Um idoso caiu no meio da rua e ninguém ajuda. O que você faz?",
    options: [
      { key: "ajudar", label: "Ajudar e levar pro hospital", karma: 15, money: -200, rep: 20, outcome: "Você gastou R$ 200 com táxi mas ganhou respeito da vizinhança." },
      { key: "ignorar", label: "Passar reto", karma: -10, money: 0, rep: -5, outcome: "Você seguiu seu rumo. A consciência pesa um pouco." },
      { key: "roubar", label: "Roubar a carteira dele", karma: -30, money: 500, rep: -25, outcome: "Você levou R$ 500 mas todo mundo viu. A favela comenta." },
    ],
  },
  {
    id: "carteira",
    scenario: "💼 Você acha uma carteira na rua com R$ 1.500 e o RG do dono.",
    options: [
      { key: "devolver", label: "Devolver ao dono", karma: 20, money: 100, rep: 25, outcome: "O dono te deu R$ 100 de recompensa e te chamou de cidadão honesto." },
      { key: "ficar", label: "Ficar com o dinheiro", karma: -15, money: 1500, rep: -10, outcome: "Você ficou rico do dia. Mas dorme inquieto." },
      { key: "policia", label: "Entregar na delegacia", karma: 10, money: 0, rep: 15, outcome: "Você fez o certo pela lei. Sem recompensa, mas a ficha agradece." },
    ],
  },
  {
    id: "vizinho",
    scenario: "🏠 Seu vizinho está sendo despejado. Ele te pede R$ 500 emprestado.",
    options: [
      { key: "emprestar", label: "Emprestar sem juros", karma: 15, money: -500, rep: 15, outcome: "Você ajudou. Talvez ele pague, talvez não." },
      { key: "juros", label: "Emprestar com juros altos", karma: -20, money: 250, rep: -15, outcome: "Você lucrou R$ 250 da desgraça alheia." },
      { key: "negar", label: "Negar e fechar a porta", karma: -5, money: 0, rep: -8, outcome: "Você manteve sua grana, mas perdeu um aliado." },
    ],
  },
  {
    id: "blitz",
    scenario: "🚓 Numa blitz a polícia para você. Eles pedem R$ 300 de propina pra te liberar.",
    options: [
      { key: "pagar", label: "Pagar a propina", karma: -15, money: -300, rep: -10, outcome: "Você passou, mas alimentou a corrupção." },
      { key: "denunciar", label: "Denunciar a corrupção", karma: 25, money: 200, rep: 30, outcome: "Você ganhou R$ 200 de bonificação e virou exemplo." },
      { key: "fugir", label: "Acelerar e fugir", karma: -10, money: 0, rep: 5, outcome: "Você escapou. Por enquanto..." },
    ],
  },
  {
    id: "doacao",
    scenario: "💝 Aparece um pedido de doação para crianças carentes da comunidade.",
    options: [
      { key: "doar100", label: "Doar R$ 100", karma: 10, money: -100, rep: 10, outcome: "Cada centavo conta. Obrigado." },
      { key: "doar500", label: "Doar R$ 500", karma: 25, money: -500, rep: 25, outcome: "Você é um anjo da quebrada." },
      { key: "ignorar", label: "Não doar", karma: -5, money: 0, rep: -3, outcome: "Você passou sem olhar." },
    ],
  },
];

export function pickRandomScenario(): MoralChoice {
  return MORAL_SCENARIOS[Math.floor(Math.random() * MORAL_SCENARIOS.length)]!;
}
