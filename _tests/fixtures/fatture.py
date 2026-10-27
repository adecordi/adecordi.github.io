# Fatture elettroniche di prova: ordinaria completa (con PDF allegato),
# semplificata e una minima.
import base64

pdf_b64 = base64.b64encode(open("doc.pdf", "rb").read()).decode()
pdf_b64 = "\n".join(pdf_b64[i:i + 76] for i in range(0, len(pdf_b64), 76))

ordinaria = f'''<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdTrasmittente>
      <ProgressivoInvio>00042</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>M5UXCR1</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdFiscaleIVA>
        <CodiceFiscale>RSSMRA80A01H501U</CodiceFiscale>
        <Anagrafica><Nome>MARIO</Nome><Cognome>ROSSI</Cognome></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via Roma</Indirizzo><NumeroCivico>10</NumeroCivico><CAP>00100</CAP><Comune>Roma</Comune><Provincia>RM</Provincia><Nazione>IT</Nazione></Sede>
      <Contatti><Telefono>06 1234567</Telefono><Email>mario.rossi@example.com</Email></Contatti>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>09876543210</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Bianchi &amp; Figli S.r.l.</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>Corso Italia</Indirizzo><NumeroCivico>5</NumeroCivico><CAP>20121</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>2026-10-01</Data>
        <Numero>42/2026</Numero>
        <DatiRitenuta><TipoRitenuta>RT01</TipoRitenuta><ImportoRitenuta>200.00</ImportoRitenuta><AliquotaRitenuta>20.00</AliquotaRitenuta><CausalePagamento>A</CausalePagamento></DatiRitenuta>
        <DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>2.00</ImportoBollo></DatiBollo>
        <ImportoTotaleDocumento>1342.00</ImportoTotaleDocumento>
        <Causale>Consulenza tecnica mese di settembre "città"</Causale>
      </DatiGeneraliDocumento>
      <DatiOrdineAcquisto><IdDocumento>ORD-77</IdDocumento><Data>2026-08-15</Data><CodiceCIG>Z1234ABCD</CodiceCIG></DatiOrdineAcquisto>
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee>
        <NumeroLinea>1</NumeroLinea>
        <CodiceArticolo><CodiceTipo>INTERNO</CodiceTipo><CodiceValore>CONS-01</CodiceValore></CodiceArticolo>
        <Descrizione>Consulenza tecnica specialistica</Descrizione>
        <Quantita>10.00</Quantita><UnitaMisura>ore</UnitaMisura>
        <DataInizioPeriodo>2026-09-01</DataInizioPeriodo><DataFinePeriodo>2026-09-30</DataFinePeriodo>
        <PrezzoUnitario>100.00000000</PrezzoUnitario>
        <PrezzoTotale>1000.00</PrezzoTotale>
        <AliquotaIVA>22.00</AliquotaIVA>
        <Ritenuta>SI</Ritenuta>
      </DettaglioLinee>
      <DettaglioLinee>
        <NumeroLinea>2</NumeroLinea>
        <Descrizione>Rimborso spese anticipate (art. 15)</Descrizione>
        <Quantita>1.00</Quantita>
        <PrezzoUnitario>120.00</PrezzoUnitario>
        <ScontoMaggiorazione><Tipo>SC</Tipo><Percentuale>10.00</Percentuale></ScontoMaggiorazione>
        <PrezzoTotale>108.00</PrezzoTotale>
        <AliquotaIVA>0.00</AliquotaIVA>
        <Natura>N1</Natura>
      </DettaglioLinee>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>1000.00</ImponibileImporto><Imposta>220.00</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo>
      <DatiRiepilogo><AliquotaIVA>0.00</AliquotaIVA><Natura>N1</Natura><ImponibileImporto>120.00</ImponibileImporto><Imposta>0.00</Imposta><RiferimentoNormativo>Escluse ex art. 15 DPR 633/72</RiferimentoNormativo></DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento>
      <CondizioniPagamento>TP02</CondizioniPagamento>
      <DettaglioPagamento>
        <Beneficiario>Mario Rossi</Beneficiario>
        <ModalitaPagamento>MP05</ModalitaPagamento>
        <DataScadenzaPagamento>2026-10-31</DataScadenzaPagamento>
        <ImportoPagamento>1142.00</ImportoPagamento>
        <IstitutoFinanziario>Banca di Prova</IstitutoFinanziario>
        <IBAN>IT60X0542811101000000123456</IBAN>
      </DettaglioPagamento>
    </DatiPagamento>
    <Allegati>
      <NomeAttachment>copia_cortesia_42</NomeAttachment>
      <FormatoAttachment>PDF</FormatoAttachment>
      <DescrizioneAttachment>Copia di cortesia</DescrizioneAttachment>
      <Attachment>{pdf_b64}</Attachment>
    </Allegati>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
'''
open("IT01234567890_00042.xml", "w", encoding="utf-8").write(ordinaria)

semplificata = '''<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronicaSemplificata versione="FSM10" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.0">
  <FatturaElettronicaHeader>
    <DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdTrasmittente><ProgressivoInvio>S0001</ProgressivoInvio><FormatoTrasmissione>FSM10</FormatoTrasmissione><CodiceDestinatario>0000000</CodiceDestinatario></DatiTrasmissione>
    <CedentePrestatore><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdFiscaleIVA><Denominazione>Bar Centrale di Rossi Mario</Denominazione><Sede><Indirizzo>Piazza Duomo</Indirizzo><NumeroCivico>1</NumeroCivico><CAP>50122</CAP><Comune>Firenze</Comune><Provincia>FI</Provincia><Nazione>IT</Nazione></Sede><RegimeFiscale>RF01</RegimeFiscale></CedentePrestatore>
    <CessionarioCommittente><IdentificativiFiscali><CodiceFiscale>BNCLCU85M41F205X</CodiceFiscale></IdentificativiFiscali><AltriDatiIdentificativi><Nome>Lucia</Nome><Cognome>Bianchi</Cognome><Sede><Indirizzo>Via Verdi</Indirizzo><CAP>50100</CAP><Comune>Firenze</Comune><Nazione>IT</Nazione></Sede></AltriDatiIdentificativi></CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD07</TipoDocumento><Divisa>EUR</Divisa><Data>2026-10-20</Data><Numero>S-15</Numero></DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi><Descrizione>Servizio catering</Descrizione><Importo>244.00</Importo><DatiIVA><Imposta>44.00</Imposta></DatiIVA></DatiBeniServizi>
    <DatiBeniServizi><Descrizione>Coperti</Descrizione><Importo>30.50</Importo><DatiIVA><Aliquota>22.00</Aliquota></DatiIVA></DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronicaSemplificata>
'''
open("semplificata.xml", "w", encoding="utf-8").write(semplificata)

minima = '''<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdTrasmittente><ProgressivoInvio>00001</ProgressivoInvio></DatiTrasmissione></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Data>2026-10-01</Data><Numero>42</Numero><Causale>Servizi &amp; consulenza "città"</Causale></DatiGeneraliDocumento></DatiGenerali></FatturaElettronicaBody></p:FatturaElettronica>
'''
open("fattura.xml", "w", encoding="utf-8").write(minima)
open("nota.txt", "w", encoding="utf-8", newline="\n").write("Nota di testo firmata.\nSeconda riga con accenti: àèìòù €\n")
