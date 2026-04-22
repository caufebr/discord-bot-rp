import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName("ajuda")
      .setDescription("Ver todos os comandos e como jogar"),
    async execute(interaction: ChatInputCommandInteraction) {
      const intro = new EmbedBuilder()
        .setTitle("📖 Bem-vindo(a) ao RP Econômico!")
        .setColor(0x5865f2)
        .setDescription(
          [
            "Este é um RPG de economia, profissões, crime, política e empresas.",
            "",
            "**Como começar:**",
            "1. Use `/saldo` — você começa com R$ 1.000.",
            "2. Use `/profissao lista` para ver carreiras e `/profissao curso` para se inscrever, depois `/profissao treinar` para se certificar.",
            "3. Receba seu pagamento com `/salario` (a cada 8h) ou faça bicos com `/trabalhar` (a cada 1h).",
            "4. Guarde dinheiro no banco com `/banco depositar` para se proteger de assaltos.",
            "5. Cuide da sua **saúde** com `/saude` e `/hospital`.",
            "6. Quando estiver mais rico, invista na `/bolsa`, abra uma `/empresa`, entre em uma `/gangue` ou participe da `/politica`.",
            "",
            "Use os botões/embeds abaixo como referência rápida.",
          ].join("\n"),
        );

      const economia = new EmbedBuilder()
        .setTitle("💰 Economia & Trabalho")
        .setColor(0x00ff88)
        .addFields(
          { name: "/saldo", value: "Ver dinheiro em mãos e no banco." },
          { name: "/banco depositar | sacar | saldo", value: "Operações bancárias (saque tem taxa)." },
          { name: "/transferir", value: "Enviar dinheiro a outro jogador (com imposto)." },
          { name: "/trabalhar", value: "Fazer um bico — cooldown de 1h." },
          { name: "/salario", value: "Receber salário da sua profissão — cooldown de 8h." },
        );

      const profissao = new EmbedBuilder()
        .setTitle("👔 Profissões & Saúde")
        .setColor(0x00aaff)
        .addFields(
          { name: "/profissao lista | curso | treinar | status", value: "Escolha e certifique sua carreira." },
          { name: "/curar", value: "Médico certificado pode curar outro jogador." },
          { name: "/defender", value: "Advogado certificado pode defender um preso." },
          { name: "/saude", value: "Ver seu status de saúde e seguro." },
          { name: "/hospital tratar | seguro", value: "Tratar-se ou comprar seguro de vida." },
        );

      const crime = new EmbedBuilder()
        .setTitle("🦹 Crime & Polícia")
        .setColor(0xff5555)
        .addFields(
          { name: "/crime", value: "Cometer um crime (5 níveis de risco e recompensa)." },
          { name: "/assaltar", value: "Tentar assaltar outro jogador — cooldown de 30min." },
          { name: "/ficha", value: "Ver sua ficha criminal e nível de procurado." },
          { name: "/prender", value: "**Policial certificado:** prender um suspeito por 1–120 minutos. (Não há comando para libertar nem gerenciar a cadeia.)" },
        );

      const sociedade = new EmbedBuilder()
        .setTitle("🏛️ Sociedade")
        .setColor(0xffaa00)
        .addFields(
          { name: "/gangue criar | convidar | sair | info | lista | guerra | banco", value: "Forme uma gangue, declare guerras e gerencie o caixa." },
          { name: "/territorio lista | invadir | coletar", value: "Disputa por territórios e renda passiva." },
          { name: "/empresa criar | info | contratar | demitir | pagar_funcionarios | anunciar | ipo | upgrade | lista", value: "Funde, cresça e abra capital de uma empresa." },
          { name: "/bolsa lista | comprar | vender | carteira | info", value: "Compre e venda ações de empresas listadas." },
          { name: "/politica governo | candidatar | votar | propor_lei | eleicao", value: "Participe do governo da cidade." },
        );

      const admin = new EmbedBuilder()
        .setTitle("🛠️ Administração")
        .setColor(0x888888)
        .addFields(
          { name: "/adm dar", value: "Dar dinheiro a um membro." },
          { name: "/adm remover", value: "Remover dinheiro de um membro." },
          { name: "/adm resetar", value: "Zerar carteira e banco de um membro." },
        )
        .setFooter({ text: "Apenas administradores do servidor podem usar /adm." });

      await interaction.reply({
        embeds: [intro, economia, profissao, crime, sociedade, admin],
        ephemeral: true,
      });
    },
  },
];
