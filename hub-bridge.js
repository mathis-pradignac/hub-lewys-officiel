/* Lewys Hub — passerelle de lecture (facultatif)
   À ajouter dans les applications Lewys hébergées sur une autre adresse (Rapports, CRM, Studio, site)
   pour que Mira puisse lire la page affichée :  <script src="https://ADRESSE-DU-HUB/hub-bridge.js"></script>
   Le script ne fait que renvoyer le texte visible de la page au Hub qui l'affiche. Il ne modifie rien. */
(function(){
  var HUBS = ['https://ADRESSE-DU-HUB']; // remplacer par l'adresse réelle du Hub (ex. https://hub-lewys.netlify.app)
  window.addEventListener('message', function(e){
    if(HUBS.indexOf(e.origin) < 0 || !e.data || e.data.lewysHub !== 'read') return;
    e.source.postMessage({ lewysHub:'page', id:e.data.id, text:(document.body.innerText || '').slice(0, 20000) }, e.origin);
  });
})();
