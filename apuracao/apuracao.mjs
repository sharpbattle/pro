import { GoogleGenAI } from "@google/genai";
import admin from "firebase-admin";

// Carrega as credenciais do Firebase (via variável de ambiente na nuvem ou arquivo local)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    const { readFileSync } = await import("fs");
    serviceAccount = JSON.parse(readFileSync(new URL('./serviceAccountKey.json', import.meta.url)));
}

// Inicializa o Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "AIzaSyDfO3OgLopr1H5lSzDf8Ee2kswU6xRFwlw" });

async function rodarBotApurgacao() {
    console.log(`\n[${new Date().toLocaleTimeString('pt-BR')}] 🔍 Iniciando ciclo de varredura no Firestore...`);

    try {
        const usuariosSnapshot = await db.collection("usuarios").get();
        
        if (usuariosSnapshot.empty) {
            console.log("Nenhum usuário encontrado no banco.");
            return;
        }

        for (const docUser of usuariosSnapshot.docs) {
            const userId = docUser.id;
            const dadosUser = docUser.data();
            let historico = dadosUser.historicoApostas || [];
            let houveAlteracao = false;

            console.log(`\n👤 Verificando usuário: ${userId}`);

            for (let i = 0; i < historico.length; i++) {
                let aposta = historico[i];
                let statusAtual = (aposta.status || "").trim().toLowerCase();

                // Processa apenas as apostas que ainda estão pendentes
                if (statusAtual === "pendente") {
                    console.log(`    ⏳ Analisando dados via JSON oficial: [${aposta.partida}] -> Palpite: "${aposta.selecao}"`);

                    const veredito = await consultarGeminiComJson(aposta);

                    console.log(`    🤖 Veredito final: ${veredito.status} (${veredito.motivo})`);

                    // Atualiza status e apenas a data de resolução
                    if (veredito.status === "Ganha" || veredito.status === "Perdida") {
                        aposta.status = veredito.status;
                        aposta.resolvidoEm = new Date().toLocaleString('pt-BR');
                        aposta.jaPediuVerificacao = true;
                        houveAlteracao = true;
                    }
                }
            }

            // Atualiza apenas o array do histórico no banco
            if (houveAlteracao) {
                await db.collection("usuarios").doc(userId).update({
                    historicoApostas: historico
                });
                console.log(`    ✅ Firestore atualizado para o usuário ${userId}!`);
            } else {
                console.log(`    ✨ Nenhuma alteração necessária para este usuário.`);
            }
        }

        console.log(`\n[${new Date().toLocaleTimeString('pt-BR')}] 🏁 Ciclo concluído.`);

    } catch (error) {
        console.error("❌ Erro ao processar apuração no banco:", error);
    }
}

async function consultarGeminiComJson(aposta) {
    const match = (aposta.urlStats || "").match(/\/([a-f0-9]{24})\/main/i);
    const gameId = match ? match[1] : null;

    if (!gameId) {
        console.log(`    ⚠️ Aposta ignorada: Não foi possível extrair o gameId de urlStats.`);
        return { status: "Pendente", motivo: "URL de estatísticas inválida ou sem gameId" };
    }

    const url = `https://eventsstat.com/en/services-api/SiteService/Game?gameId=${gameId}&ln=pt`;
    console.log(`    🌐 Baixando dados oficiais da API: ${url}`);
    
    try {
        const responseApi = await fetch(url);
        const dadosPartida = await responseApi.json();

        // 🛑 TRAVA DE STATUS (API eventsstat):
        // St = 1: Não iniciado | St = 2: Ao Vivo | St = 3: Encerrado
        if (dadosPartida.St !== 3) {
            const estadoTexto = dadosPartida.St === 2 ? "Jogo em andamento (Ao Vivo)" : "Jogo ainda não iniciado";
            console.log(`    ⏳ [TRAVA DE SEGURANÇA] Partida não finalizada (St: ${dadosPartida.St} - ${estadoTexto}). Pulando chamada de IA.`);
            return { 
                status: "Pendente", 
                motivo: `${estadoTexto}. Apuração ignorada até o apito final.` 
            };
        }

        console.log(`    🟢 Jogo confirmado como FINALIZADO (St: 3). Enviando para validação da IA...`);

        const prompt = `
Você é um auditor rigoroso de resultados esportivos.
A partida já está CONFIRMADA COMO ENCERRADA. Sua tarefa é auditar se o palpite do apostador foi vitorioso ("Ganha") ou derrotado ("Perdida").

Detalhes da Aposta:
- Partida: "${aposta.partida}"
- Palpite / Mercado: "${aposta.selecao}"

Resultado Oficial Definitivo da Partida:
- Placar Final Mandante (S1): ${dadosPartida.S1}
- Placar Final Visitante (S2): ${dadosPartida.S2}
- Estatísticas complementares (escanteios, cartões, chutes): ${JSON.stringify(dadosPartida.U || [])}

Regras Obrigatórias:
1. Retorne "Ganha" se o placar ou estatísticas confirmam que o palpite bateu.
2. Retorne "Perdida" se o placar ou estatísticas confirmam que o palpite NÃO bateu.
3. Retorne "Pendente" somente se os dados estiverem visivelmente corrompidos ou o evento foi anulado/adiado.
4. Forneça uma explicação técnica e concisa no campo "motivo".
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        status: { 
                            type: "STRING", 
                            enum: ["Ganha", "Perdida", "Pendente"] 
                        },
                        motivo: { type: "STRING" }
                    },
                    required: ["status", "motivo"]
                }
            }
        });

        return JSON.parse(response.text);

    } catch (error) {
        console.error("❌ Erro ao buscar dados da API ou processar com o Gemini:", error);
        return { status: "Pendente", motivo: "Erro ao consultar API de resultados ou erro no modelo" };
    }
}

// Executa a apuração imediatamente
rodarBotApurgacao();
