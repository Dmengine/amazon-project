import {cart, deleteCartItem, calculateCartQuantity, updateQuantity, updateDeliveryOption} from '../data/cart.js';
import {formatCurrency} from './utils/money.js';
import {products} from '../data/products.js';
import dayjs from 'https://unpkg.com/dayjs@1.11.10/esm/index.js';
import { deliveryOptions } from '../data/deliveryOptions.js';


// const today = dayjs();
// const deliveryOption = today.add(7, 'days');
// console.log(deliveryOption.format('dddd, MMMM D'))

let checkoutSummaryHTML = '';

cart.forEach((cartItem) => {
  const productId = cartItem.productId;

  let matchingProduct;

  products.forEach((product) => {
    if (product.id === productId) {
      matchingProduct = product;
    }
  });

  const deliveryOptionId = cartItem.deliveryOptionsId;
  // console.log(deliveryOptionId);

  let matchingDeliveryOptionId;

  deliveryOptions.forEach((deliveryOption) => {
    if(deliveryOption.id === deliveryOptionId){
      matchingDeliveryOptionId = deliveryOption;
    }
  });

  const today = dayjs();
  const deliveryDay = today.add(matchingDeliveryOptionId.deliveryDays, 'days');
  const dateString = deliveryDay.format('dddd, MMMM D');

  checkoutSummaryHTML +=`
      <div class="cart-item-container is-editing-quantity js-cart-item-container-${matchingProduct.id}">
        <div class="delivery-date">
          Delivery date: ${dateString}
        </div>
        <div class="cart-item-details-grid">
          <img class="product-image"
            src="${matchingProduct.image}">

          <div class="cart-item-details">
            <div class="product-name">
              ${matchingProduct.name}
            </div>
            <div class="product-price">
              $${formatCurrency(matchingProduct.priceCents)}
            </div>
            <div class="product-quantity">
              <span>
                Quantity: <span class="quantity-label
                  js-quantity-label-${matchingProduct.id}
                ">${cartItem.quantity}</span>
              </span>
              <span class="update-quantity-link link-primary js-update-quantity"
                data-product-id = '${matchingProduct.id}'>
                Update
              </span>
              <input class="quantity-input" >
              <span class="save-quantity-link link-primary js-save-link"
                data-product-id="${matchingProduct.id}"
                >Save</span>
              <span class="delete-quantity-link link-primary js-delete-quantity" 
                data-product-id = '${matchingProduct.id}'>
                Delete
              </span>
            </div>
          </div>
          <div class="delivery-options">
            <div class="delivery-options-title">
              Choose a delivery option:
            </div>
            ${deliveryOptionHTML(matchingProduct, cartItem)}
          </div>
        </div>
      </div>
  `;
})


document.querySelector('.js-order-summary').innerHTML = checkoutSummaryHTML;

document.querySelectorAll('.js-update-quantity').
  forEach((button) => {
    button.addEventListener('click', () => {
    const {productId} = button.dataset;
    //console.log(productId)
    const container = document.querySelector(`.js-cart-item-container-${productId}`)
    container.classList.add('is-editing-quantity')
    });
  });

document.querySelectorAll('.js-delete-quantity').
  forEach((button) => {
    button.addEventListener('click', () => {
    const {productId} = button.dataset;
    deleteCartItem(productId);
      //console.log('delete')

      const container = document.querySelector(`.js-cart-item-container-${productId}`);
      container.remove();
      updateCartQuantity()
    });
  });


  function updateCartQuantity (){
    let cardQuantity = calculateCartQuantity();
  
    document.querySelector('.js-return-home-link').
          innerHTML = `${cardQuantity} items`;
  }
  
  updateCartQuantity()

  document.querySelectorAll('.js-save-link').
  forEach((button) => {
    button.addEventListener('click', () => {
      const {productId} = button.dataset;
      const container = document.querySelector(`.js-cart-item-container-${productId}`)
      container.classList.remove('.is-editing-quantity')

      saveQuantityItem = document.querySelector(`.js-save-link-${productId}`).innerHTML;
      newQuantity = Number(saveQuantityItem.value);

      if(newQuantity < 0 || newQuantity >= 1000){
        alert('Quantity must be at least 0 and less than 1000');
        return;
      }

      updateQuantity(productId, newQuantity);



      const quantityLabel = document.querySelector(
        `.js-quantity-label-${productId}`
      );
      quantityLabel.innerHTML = newQuantity;

      updateCartQuantity();

    });
  });


  function deliveryOptionHTML(matchingProduct, cartItem){
    let html = '';

    deliveryOptions.forEach((deliveryOption) => {
      const today = dayjs();
      const deliveryDay = today.add(deliveryOption.deliveryDays, 'days');
      const dateString = deliveryDay.format('dddd, MMMM D');
      // console.log(dateString);
      const priceString = 
        deliveryOption.priceCents === 0 
        ? 'FREE'
        : `$${formatCurrency(deliveryOption.priceCents)} -`;

        const isChecked = cartItem.deliveryOptionsId === deliveryOption.id;

      html +=`
            <div class="delivery-option js-delivery-option"
              data-product-id = ${matchingProduct.id}
              data-delivery-option-id = ${deliveryOption.id}
              >
              <input type="radio" checked
                ${isChecked ? 'checked' : ''}
                class="delivery-option-input"
                name="delivery-option-${matchingProduct.id}">
              <div>
                <div class="delivery-option-date">
                  ${dateString}
                </div>
                <div class="delivery-option-price">
                  ${priceString} Shipping
                </div>
              </div>
            </div>
      `;
    });
    return html;
  }

document.querySelectorAll('.js-delivery-option').forEach((element)=>{
  element.addEventListener('click', ()=> {
    const {productId, deliveryOptionId} = element.dataset;
    updateDeliveryOption(productId, deliveryOptionId)
  })
})